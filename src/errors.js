export class SnowgateError extends Error {
  constructor(message, code = 'SNOWGATE_ERROR') {
    super(message);
    this.name = 'SnowgateError';
    this.code = code;
  }
}

// A table could not be read (forbidden, missing, or failing). Discovery records
// these as limitations instead of guessing.
export class TableAccessError extends SnowgateError {
  constructor(table, status, message) {
    super(message, 'TABLE_ACCESS');
    this.name = 'TableAccessError';
    this.table = table;
    this.status = status;
  }
}

// Authentication failed — discovery aborts, nothing is guessed.
export class AuthError extends SnowgateError {
  constructor(message) {
    super(message, 'AUTH');
    this.name = 'AuthError';
  }
}
