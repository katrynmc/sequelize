import type { AbstractConnection, ConnectionOptions } from '@sequelize/core';
import { AbstractConnectionManager, ConnectionError, ConnectionRefusedError } from '@sequelize/core';
import { inspect } from '@sequelize/utils';
import { removeUndefined } from '@sequelize/core/_non-semver-use-at-your-own-risk_/utils/object.js';
import { logger } from '@sequelize/core/_non-semver-use-at-your-own-risk_/utils/logger.js';
import type { ConnectionParameters, NodeOdbcError, Connection as OdbcConnection } from 'odbc';
import * as Odbc from 'odbc';
import type { IBMiDialect } from './dialect.js';
import type * as IbmDb from 'ibm_db';

const debug = logger.debugContext('connection:ibmi');

export type OdbcModule = typeof Odbc;
export type IbmDbModule = typeof IbmDb;

export type IBMiModule = OdbcModule | IbmDbModule;

export interface IBMiOdbcConnection extends AbstractConnection, OdbcConnection {
  // properties of ObdcConnection, but not declared in their typings
  connected: boolean;
}

export interface IBMiDb2Connection extends AbstractConnection, IbmDb.Database {}

export type IBMiConnection = IBMiOdbcConnection | IBMiDb2Connection;

export interface IBMiOdbcConnectionOptions extends Omit<ConnectionParameters, 'connectionString'> {
  /**
   * Any extra ODBC connection string parts to use.
   *
   * Will be prepended to the connection string parts produced by the other options.
   */
  odbcConnectionString?: string;

  /**
   * The ODBC "DSN" part of the connection string.
   */
  dataSourceName?: string;

  /**
   * The ODBC "UID" part of the connection string.
   */
  username?: string;

  /**
   * The ODBC "PWD" part of the connection string.
   */
  password?: string;

  /**
   * The ODBC "SYSTEM" part of the connection string.
   */
  system?: string;
}

export interface IBMiDb2ConnectionOptions {
  /**
   * ODBC "DATABASE" parameter
   */
  database?: string;

  /**
   * ODBC "HOSTNAME" parameter
   */
  hostname?: string;

  /**
   * Additional ODBC parameters. Used to build the connection string.
   */
  odbcOptions?: Record<string, string>;

  /**
   * ODBC "PWD" parameter
   */
  password?: string;

  /**
   * ODBC "PORT" parameter
   */
  port?: number | string;

  /**
   * Sets ODBC "Security" parameter to SSL
   */
  ssl?: boolean;

  /**
   * ODBC "SSLServerCertificate" parameter
   */
  sslServerCertificate?: string;

  /**
   * ODBC "UID" parameter
   */
  username?: string;
}

export type IBMiConnectionOptions = IBMiOdbcConnectionOptions | IBMiDb2ConnectionOptions;

function isIbmDbModule(lib: IBMiModule): lib is IbmDbModule {
  return typeof (lib as IbmDbModule).Database === 'function';
}

function isOdbcModule(lib: IBMiModule): lib is OdbcModule {
  return typeof (lib as OdbcModule).connect === 'function';
}

export class IBMiConnectionManager extends AbstractConnectionManager<IBMiDialect, IBMiConnection> {
  readonly #lib: IBMiModule;
  readonly #connectionType: 'ibm_db' | 'odbc';

  constructor(dialect: IBMiDialect) {
    super(dialect);

    this.#lib = this.#resolveConnectionModule(dialect);
    this.#connectionType = dialect.options.connectionType ?? "odbc";
  }

  #resolveConnectionModule(dialect: IBMiDialect): IBMiModule {
    const { connectionType, ibmDbModule, odbcModule } = dialect.options;

    if (connectionType === "ibm_db") {
      if (!ibmDbModule) {
        throw new Error(
          'The "ibm_db" connectionType was specified, but the "ibm_db" module is not installed. You must install it to use the native bindings.',
        );
      }

      return ibmDbModule;
    }

    return odbcModule ?? Odbc;
  }

  async #connectIBMiDb2(config: IBMiDb2ConnectionOptions): Promise<IBMiDb2Connection> {
    if (!isIbmDbModule(this.#lib)) {
      throw new Error(
        'The "ibm_db" connectionType was specified, but the "ibm_db" module is not loaded correctly.',
      );
    }

    const connectionConfig: Record<string, string> = removeUndefined({
      DATABASE: config.database,
      HOSTNAME: config.hostname,
      PORT: config.port ? String(config.port) : '50000',
      UID: config.username,
      PWD: config.password,
      SSLServerCertificate: config.sslServerCertificate,
    });

    if (config.ssl) {
      connectionConfig.Security = 'SSL';
    }

    if (config.odbcOptions) {
      for (const optionName of Object.keys(config.odbcOptions)) {
        if (connectionConfig[optionName]) {
          throw new Error(
            `Key ${inspect(optionName)} in "odbcOptions" was already set by a built-in option`,
          );
        }

        connectionConfig[optionName] = config.odbcOptions[optionName];
      }
    }

    // TODO: add relevant Database options to the connection options of this dialect
    const connection: IBMiDb2Connection = new this.#lib.Database();

    return new Promise((resolve, reject) => {
      // ibm_db's typings for the OBDC connection string are missing many properties
      connection.open(connectionConfig as unknown as IbmDb.ConnStr, error => {
        if (error) {
          if (error.message && error.message.includes('SQL30081N')) {
            return void reject(new ConnectionRefusedError(error));
          }

          return void reject(new ConnectionError(error));
        }

        return void resolve(connection);
      });
    });
  }

  async #connectOdbc(config: IBMiOdbcConnectionOptions): Promise<IBMiConnection> {
    if (!isOdbcModule(this.#lib)) {
      throw new Error('ODBC module not properly loaded.');
    }

    const connectionKeywords = [];
    if (config.odbcConnectionString) {
      connectionKeywords.push(config.odbcConnectionString);
    }

    if (config.dataSourceName) {
      connectionKeywords.push(`DSN=${config.dataSourceName}`);
    }

    if (config.username) {
      connectionKeywords.push(`UID=${config.username}`);
    }

    if (config.password) {
      connectionKeywords.push(`PWD=${config.password}`);
    }

    if (config.system) {
      connectionKeywords.push(`SYSTEM=${config.system}`);
    }

    if (connectionKeywords.length === 0) {
      throw new Error('No connection information provided.');
    }

    let connectionString: string = connectionKeywords.join(';');
    if (!connectionString.endsWith(';')) {
      connectionString += ';';
    }

    let connection;
    try {
      connection = (await this.#lib.connect(connectionString)) as IBMiConnection;
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }

      if (error.toString().includes('Error connecting to the database')) {
        throw new ConnectionRefusedError(error);
      }

      throw error;
    }

    return connection;
  }

  async connect(config: ConnectionOptions<IBMiDialect>): Promise<IBMiConnection> {
    if (this.#connectionType === 'ibm_db') {
      return this.#connectIBMiDb2(config);
    }

    return this.#connectOdbc(config);
  }

  async #disconnectIBMiDb2(connection: IBMiDb2Connection) {
    // Don't disconnect a connection that is already disconnected
    if (!this.validate(connection)) {
      return;
    }

    await connection.close();
  }

  async #disconnectOdbc(connection: IBMiOdbcConnection): Promise<void> {
    if (!this.validate(connection)) {
      debug('Tried to disconnect, but connection was already closed.');

      return;
    }

    await new Promise<void>((resolve, reject) => {
      connection.close((error: NodeOdbcError) => {
        if (error) {
          return void reject(error);
        }

        resolve();

        return undefined;
      });
    });
  }

  async disconnect(connection: IBMiConnection): Promise<void> {
    if (this.#connectionType === 'ibm_db') {
      return this.#disconnectIBMiDb2(connection as IBMiDb2Connection);
    }

    return this.#disconnectOdbc(connection as IBMiOdbcConnection);
  }

  validate(connection: IBMiConnection): boolean {
    return connection.connected;
  }
}
