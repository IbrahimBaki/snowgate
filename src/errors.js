export class SnowgateError extends Error {
  // details: structured facts about the failure (table, fields, action, kind)
  // used by feedback; never shown instead of the message.
  constructor(message, code = 'SNOWGATE_ERROR', details = undefined) {
    super(message);
    this.name = 'SnowgateError';
    this.code = code;
    if (details) this.details = details;
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
