import _ from 'lodash';
import Promise from 'bluebird';
import Runner from '../../common/actions/runner';

export default class extends Runner {

  constructor({runnerState}) {
    super({runnerState});
    this.reset();
  }

  reset() {
    super.reset();
    this.json = {};
  }

  resetProgress() {
    super.reset();
    this.lineNumber = 0;
    this.progress = 0;
  }

  parsePromise({text = undefined, nLinesBetweenProgressEvents = 1000, onProgress = undefined, format = 'magic'} = {}) {

    // Check for a valid input.
    if (typeof(text) !== 'string') {
      text = '';
      this._appendWarning('Contribution text is not a string.');
    }
    if (_.isEmpty(text)) {
      text = '';
      this._appendWarning('Contribution text is empty.');
    }

    // Initialize this parsing operation.
    this.table = undefined;
    this.columns = [];
    this.skipTable = false;
    this.tableLineNumber = 0;

    return new Promise.each(
      _.chunk(text.match(/[^\r\n]+/g), nLinesBetweenProgressEvents),
      (lines, i, t) => {
        return new Promise((resolve) => {
          lines.forEach(line => this._parseLine(line, format));
          this.progress = 100 * (i + 1) / t;
          if (onProgress) onProgress(this.progress);
          resolve();
        }).delay();
      }
    ).then(() => {
      for (let jsonTable in this.json) {
        if (this.json[jsonTable].length === 0)
          this._appendWarning(`No data values were found in the ${jsonTable} table.`);
      }
    });
    
  }

  _parseLine(line, format) {

    // Skip empty lines.
    if (line === undefined || line.trim() === '') return;

    // Skip lines if skipping table.
    if (this.skipTable) return;

    // Record the line number.
    this.lineNumber++;
    this.tableLineNumber++;

    // If this line ends a table, initialize a new table.
    if (line.trim().match(/^>+$/)) {
      this.table = undefined;
      this.columns = [];
      this.tableLineNumber = 0;
      this.skipTable = false;
    }

    // If this is the first line of a table, look for the table name.
    else if (format === 'magic' && this.tableLineNumber === 1) {

      // Split the table definition on the tab character.
      let tableDefinition = line.split(/\t/);

      // Check table definition has at least 2 elements in it.
      if (tableDefinition.length < 2) {
        this._appendError('Invalid table definition. Expected something like "tab[tab]measurements[new line]".');
        this.skipTable = true;
      }

      // Clean leading and trailing whitespace from each part of the table definition.
      tableDefinition = tableDefinition.map((value) => { return value.trim(); });

      // Check the column delimiter is "tab".
      if (!tableDefinition[0].match(/^tab(\s|$)/i)) {
        this._appendError(`Unrecognized column delimiter "${tableDefinition[0]}". Expected "tab".`);
        this.skipTable = true;
      }

      // Tab has been found, check for table name.
      else if (tableDefinition[1] === undefined || tableDefinition[1] === '') {
        this._appendError(`No table name following tab delimiter.`);
        this.skipTable = true;
      }

      // Save the table name and add it to the JSON if necessary.
      else {
        this.table = tableDefinition[1].toLowerCase();
        if (!this.json.hasOwnProperty(this.table))
          this.json[this.table] = [];
      }

    }

    // If this is the second line of a table, look for the column names.
    else if (
        (format === 'magic' && this.tableLineNumber === 2) ||
        (format === 'tsv' && this.tableLineNumber === 1)
      ) {

      // Split the column definition on the tab character.
      this.columns = line.split(/\t/);

      // Check for column names.
      if (this.columns.length === 0) {
        this._appendError('No column names found.');
        this.skipTable = true;
      }

      // Clean leading and trailing whitespace from each column name.
      this.columns = this.columns.map((value) => { return value.trim().toLowerCase(); });

      // Check for empty column names.
      if (_.findIndex(this.columns, '') !== -1) {
        this._appendError('Empty column names are not allowed.');
        this.skipTable = true;
      }

      // Check for duplicate column names.
      if (this.columns.length !== _.uniq(this.columns).length) {
        this._appendError('Found duplicate column names.');
        this.skipTable = true;
      }

      if (format === 'magic' && (
          this.table === 'measurements' ||
          this.table === 'magic_measurements'))
        this.json[this.table] = { columns: this.columns, rows: [] };

    }

    // Otherwise, parse the row.
    else {

      // Split the row values on the tab character.
      let values = line.split(/\t/);

      // Check there are enough column names.
      if (values.length > this.columns.length) {
        this._appendError('More values found than columns.');
        this.skipTable = true;
      }

      // Append the row of values onto the table in the JSON.
      else {

        // Remove leading and trailing whitespace.
        values = values.map((value) => { return value.trim(); });

        // Combine the columns and values into an object.
        let row = _.zipObject(this.columns.slice(0, values.length), values);

        // Remove empty values
        if (format === 'magic' && (
            this.table === 'measurements' ||
            this.table === 'magic_measurements'))
          row = values;
        else
          row = _.omitBy(row, (value, key) => { return value === ""; });

        // Use a default table of 'unknown' for non MagIC text files.
        if (this.table === undefined) {
          this._appendError(`No table name defined.`);
          this.table = 'unknown';
          this.json[this.table] = [];
        }

        // Append the values to the table in JSON.
        if (format === 'magic' && (
            this.table.toLowerCase() === 'measurements' ||
            this.table.toLowerCase() === 'magic_measurements'))
          this.json[this.table].rows.push(row);
        else
          this.json[this.table].push(row);

      }

    }

  }
  
}
