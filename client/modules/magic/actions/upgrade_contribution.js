import _ from 'lodash';
import jQuery from 'jquery';
import moment from 'moment-timezone';
import Promise from 'bluebird';
import Runner from '../../common/actions/runner';
import ValidateContribution from './validate_contribution';

import {default as versions} from '../../../../lib/modules/magic/magic_versions';
import {default as models} from '../../../../lib/modules/magic/data_models';

// This class upgrades the json data from its current model to the newest model if a newer model is available.
export default class extends Runner {

  constructor({runnerState}) {
    super({runnerState});
    runnerState = this.runnerState;
    this.validator = new ValidateContribution({runnerState});
    this.initialize();

    // Make a list of unique composite keys for each table.
    this.mergeKeys = {
      locations: ['location'],
      sites: ['site'], //, 'location'],
      samples: ['sample'], //, 'site'],
      specimens: ['specimen'], //, 'sample'],
      criteria: ['criterion', 'table_column'],
      ages: ['location', 'site', 'sample', 'specimen'],
      images: ['location', 'site', 'sample', 'specimen']
    };

  }

  reset() {
    super.reset();
    this.validator.reset();
    this.initialize();
    console.log('upgrade reset');
  }

  initialize() {
    this.jsonOld = undefined;
    this.versionOld = undefined;
    this.modelOld = undefined;

    this.jsonNew = {};
    this.versionNew = undefined;
    this.modelNew = undefined;

    this.json = {};
    this.version = undefined;
    this.upgradeMap = {};

    this.progress = 0;
    this.nRowsBetweenProgressEvents = 1000;
    this.onProgress = undefined;

    this.newMethodCodes = {};
    this.syntheticSpecimenNames = {};
    this.collisionErrors = {};
    this.undefinedTableColumnErrors = {};
    this.deletedTableColumnWarnings = {};
  }

  // Upgrade a contribution to its next MagIC data model version.
  // The input JSON can be assumed to be the entire contribution.
  // The upgrade happens in two stages: map column names and then merge rows.
  upgradePromise({json = undefined, nRowsBetweenProgressEvents = 1000, onProgress = undefined} = {}) {

    this.reset();
    this.nRowsBetweenProgressEvents = nRowsBetweenProgressEvents;
    this.onProgress = onProgress;

    // Retrieve the data model version used in the json.
    let { version, isGuessed } = this.validator.getVersion(json);
    this.json = json;
    this.version = version;

    // If the data model version could not be found or guessed, stop here.
    if (!this.version)
      return Promise.resolve();

    this.jsonOld = json;
    this.versionOld = version;
    return this._mapPromise().then(this._mergePromise.bind(this));

  }

  _mapPromise() {

    // Make a list of versions after the current version up to the newest version.
    const versionsToNewest = _.takeRightWhile(versions, v => {return (v !== this.versionOld)});
    if (versionsToNewest.length === 0)
      return Promise.resolve();

    const versionPercentProgress = 50 / versionsToNewest.length;
    return Promise.each(versionsToNewest, (versionNew, versionIdx) => {

      // Retrieve the data models and create the upgrade map.
      this.versionNew = versionNew;
      this.modelOld = models[this.versionOld];
      this.modelNew = models[this.versionNew];
      this.upgradeMap = this.getUpgradeMap(this.modelNew);

      // RCJM: using this for a quick sanity check of the upgrade map
      /*for (let t in this.upgradeMap)
       for (let c in this.upgradeMap[t])
       if (this.upgradeMap[t][c].length > 1 && t != 'pmag_results' && t != 'rmag_results')
       console.log(t, c, this.upgradeMap[t][c]);*/

      const rowsTotal = _.reduce(this.jsonOld, (rowsTotal, table) => {
        return rowsTotal + (table.rows ? table.rows.length : table.length);
      }, 0);

      const modelTables = _.orderBy(_.keys(this.modelOld['tables']), (t) => {
        return this.modelOld['tables'][t].position;
      }, 'asc');
      const tables = _.union(_.intersection(modelTables, _.keys(this.jsonOld)), _.keys(this.jsonOld));
      if (tables.length === 0)
        return Promise.resolve();

      // Handle special cases when upgrading from 2.5 to 3.0 tables.
      if (this.versionNew === '3.0') {

        // Unofficially add a mapping from er_expeditions to locations because the 2.5 model
        // doesn't include a foreign key.
        this.modelOld['tables']['er_expeditions']['columns']['er_location_name'] = {};
        this.modelNew['tables']['locations']['columns']['location']['previous_columns'].push(
          {'table': 'er_expeditions', 'column': 'er_location_name'}
        );

        // Favor synthetic names over specimen names for natural synthetics.
        if (this.jsonOld['er_specimens'] && this.jsonOld['er_synthetics']) {
          for (let jsonRowOldIdx in this.jsonOld['er_synthetics']) {
            let syntheticRow = this.jsonOld['er_synthetics'][jsonRowOldIdx];
            if (syntheticRow['er_specimen_name'] && syntheticRow['er_synthetic_name']) {
              this.syntheticSpecimenNames[syntheticRow['er_specimen_name']] = syntheticRow['er_synthetic_name'];
            }
          }
        }

        // Define new method code names in 3.0.
        this.newMethodCodes['ST-BC'] = 'ST-C';
        this.newMethodCodes['ST-BC-Q1'] = 'ST-BCQ-1';
        this.newMethodCodes['ST-BC-Q2'] = 'ST-BCQ-2';
        this.newMethodCodes['ST-BC-Q3'] = 'ST-BCQ-3';
        this.newMethodCodes['ST-BC-Q4'] = 'ST-BCQ-4';
        this.newMethodCodes['ST-BC-Q5'] = 'ST-BCQ-5';
        this.newMethodCodes['ST-CT'] = 'ST-G';
        this.newMethodCodes['ST-IC'] = 'ST-C-I';
        this.newMethodCodes['ST-IFC'] = 'ST-G-IF';
        this.newMethodCodes['ST-VV-Q1'] = 'ST-VVQ-1';
        this.newMethodCodes['ST-VV-Q2'] = 'ST-VVQ-2';
        this.newMethodCodes['ST-VV-Q3'] = 'ST-VVQ-3';
        this.newMethodCodes['ST-VV-Q4'] = 'ST-VVQ-4';
        this.newMethodCodes['ST-VV-Q5'] = 'ST-VVQ-5';
        this.newMethodCodes['ST-VV-Q6'] = 'ST-VVQ-6';
        this.newMethodCodes['ST-VV-Q7'] = 'ST-VVQ-7';

      }

      let rowProgressCounter = 0;
      return Promise.each(tables, jsonTableOld => {

        //console.log('mapping_table', jsonTableOld, rowProgressCounter, this.versionOld, '\n', this.jsonOld);

        // Handle special cases when upgrading from 2.5 to 3.0 tables.
        if (this.versionNew === '3.0') {

          // Don't warn about these tables being deleted when upgrading from 2.5 to 3.0.
          if (jsonTableOld === 'magic_methods' ||
            jsonTableOld === 'er_citations' ||
            jsonTableOld === 'er_mailinglist' ||
            jsonTableOld === 'magic_calibrations' ||
            jsonTableOld === 'magic_instruments') {
            rowProgressCounter += this.jsonOld[jsonTableOld].length;
            return Promise.resolve();
          }

          if (jsonTableOld === 'er_expeditions') {
            let expeditionsNew = [];
            for (let expeditionRowIdx in this.jsonOld['er_expeditions']) {
              let expeditionRow = this.jsonOld['er_expeditions'][expeditionRowIdx];

              // If a list of locations for this expedition is provided, duplicate the
              // expedition row for each location and add the er_location_name column.
              if (expeditionRow['expedition_location']) {
                let expeditionLocations = expeditionRow['expedition_location']
                expeditionLocations = expeditionLocations.replace(/(^:|:$)/g, '');
                expeditionLocations = expeditionLocations.split(':');
                for (let expeditionLocation of expeditionLocations) {
                  expeditionRow['er_location_name'] = expeditionLocation;
                  expeditionsNew.push(_.cloneDeep(expeditionRow));
                }
              }

              // Otherwise, duplicate the expedition row for each location and add the er_location name column.
              else {
                for (let locationRowIdx in this.jsonOld['er_locations']) {
                  let locationRow = this.jsonOld['er_locations'][locationRowIdx];
                  expeditionRow['er_location_name'] = locationRow['er_location_name'];
                  expeditionsNew.push(_.cloneDeep(expeditionRow));
                }
              }

            }
            this.jsonOld['er_expeditions'] = expeditionsNew;
          }

          // Split tilt stratigraphic/corrected/uncorrected directions.
          if (jsonTableOld === 'pmag_results') {
            let resultsNew = [];
            for (let resultRowIdx in this.jsonOld['pmag_results']) {
              let resultsRow = this.jsonOld['pmag_results'][resultRowIdx];
              let hasStratigraphic = (
                resultsRow['average_inc'    ] ||
                resultsRow['average_dec'    ] ||
                resultsRow['average_sigma'  ] ||
                resultsRow['average_alpha95'] ||
                resultsRow['average_n'      ] ||
                resultsRow['average_nn'     ] ||
                resultsRow['average_k'      ] ||
                resultsRow['average_r'      ]
              );
              let hasTiltCorrected = (
                resultsRow['tilt_inc_corr'    ] ||
                resultsRow['tilt_dec_corr'    ] ||
                resultsRow['tilt_k_corr'      ] ||
                resultsRow['tilt_alpha95_corr'] ||
                resultsRow['tilt_k_ratio'     ] ||
                resultsRow['tilt_n'           ] ||
                resultsRow['tilt_correction'  ]
              );
              let hasTiltUncorrected = (
                resultsRow['tilt_inc_uncorr'    ] ||
                resultsRow['tilt_dec_uncorr'    ] ||
                resultsRow['tilt_k_uncorr'      ] ||
                resultsRow['tilt_alpha95_uncorr']
              );

              // If the pmag_results row contains directional data, make sure it's not mixed with other directions.
              if (hasStratigraphic || hasTiltCorrected || hasTiltUncorrected) {

                // Create the stratigraphic row.
                if (hasStratigraphic) {
                  let stratigraphicRow = _.cloneDeep(resultsRow);
                  delete stratigraphicRow['tilt_inc_corr'];
                  delete stratigraphicRow['tilt_dec_corr'];
                  delete stratigraphicRow['tilt_k_corr'];
                  delete stratigraphicRow['tilt_alpha95_corr'];
                  delete stratigraphicRow['tilt_k_ratio'];
                  delete stratigraphicRow['tilt_n'];
                  delete stratigraphicRow['tilt_inc_uncorr'];
                  delete stratigraphicRow['tilt_dec_uncorr'];
                  delete stratigraphicRow['tilt_k_uncorr'];
                  delete stratigraphicRow['tilt_alpha95_uncorr'];
                  stratigraphicRow['tilt_correction'] = '100';
                  resultsNew.push(stratigraphicRow);
                }

                // Create the tilt corrected row.
                if (hasTiltCorrected) {
                  let tiltCorrectedRow = _.cloneDeep(resultsRow);
                  delete tiltCorrectedRow['average_inc'];
                  delete tiltCorrectedRow['average_dec'];
                  delete tiltCorrectedRow['average_sigma'];
                  delete tiltCorrectedRow['average_alpha95'];
                  delete tiltCorrectedRow['average_n'];
                  delete tiltCorrectedRow['average_nn'];
                  delete tiltCorrectedRow['average_k'];
                  delete tiltCorrectedRow['average_r'];
                  delete tiltCorrectedRow['tilt_inc_uncorr'];
                  delete tiltCorrectedRow['tilt_dec_uncorr'];
                  delete tiltCorrectedRow['tilt_k_uncorr'];
                  delete tiltCorrectedRow['tilt_alpha95_uncorr'];
                  if (tiltCorrectedRow['tilt_correction'] === undefined)
                    tiltCorrectedRow['tilt_correction'] = '-3'; // tilt correction is unknown
                  resultsNew.push(tiltCorrectedRow);
                }

                // Create the tilt uncorrected row.
                if (hasTiltUncorrected) {
                  let tiltUncorrectedRow = _.cloneDeep(resultsRow);
                  delete tiltUncorrectedRow['average_inc'];
                  delete tiltUncorrectedRow['average_dec'];
                  delete tiltUncorrectedRow['average_sigma'];
                  delete tiltUncorrectedRow['average_alpha95'];
                  delete tiltUncorrectedRow['average_n'];
                  delete tiltUncorrectedRow['average_nn'];
                  delete tiltUncorrectedRow['average_k'];
                  delete tiltUncorrectedRow['average_r'];
                  delete tiltUncorrectedRow['tilt_inc_corr'];
                  delete tiltUncorrectedRow['tilt_dec_corr'];
                  delete tiltUncorrectedRow['tilt_k_corr'];
                  delete tiltUncorrectedRow['tilt_alpha95_corr'];
                  delete tiltUncorrectedRow['tilt_k_ratio'];
                  delete tiltUncorrectedRow['tilt_n'];
                  tiltUncorrectedRow['tilt_correction'] = '0';
                  resultsNew.push(tiltUncorrectedRow);
                }

              } else {
                resultsNew.push(_.cloneDeep(resultsRow));
              }
            }
            this.jsonOld['pmag_results'] = resultsNew;
          }

          if (jsonTableOld === 'magic_measurements') {

            // Check that the magic_measurements table has a list of columns and a list or rows.
            if (!Array.isArray(this.jsonOld['magic_measurements'].columns) ||
                !Array.isArray(this.jsonOld['magic_measurements'].rows)) {
              this._appendError(`Table "${jsonTableOld}" ` +
                `has not been parsed properly.`);
            }

            else {

              // Create a measurements table.
              this.jsonNew['measurements'] = { columns: [], rows: [] };

              // Map the magic_measurements columns into measurements columns.
              let pullIdxs = [];
              for (let columnIdx in this.jsonOld['magic_measurements'].columns) {

                let jsonColumnOld = this.jsonOld['magic_measurements'].columns[columnIdx];

                // Check that the old column is defined in the old data model.
                if (!this.modelOld['tables'][jsonTableOld]['columns'][jsonColumnOld]) {
                  if (!this.undefinedTableColumnErrors[jsonTableOld + '.' + jsonColumnOld])
                    this._appendError(`Column "${jsonColumnOld}" in table "${jsonTableOld}" ` +
                      `is not defined in MagIC Data Model version ${this.versionOld}.`);
                  this.undefinedTableColumnErrors[jsonTableOld + '.' + jsonColumnOld] = true;
                  pullIdxs.push(columnIdx);
                  continue;
                }

                // Check that the old table and column are defined in the new data model.
                if (!this.upgradeMap[jsonTableOld] || !this.upgradeMap[jsonTableOld][jsonColumnOld]) {
                  if (!this.deletedTableColumnWarnings[jsonTableOld + '.' + jsonColumnOld])
                    this._appendWarning(`Column "${jsonColumnOld}" in table "${jsonTableOld}" ` +
                      `was deleted in MagIC Data Model version ${this.versionNew}.`);
                  this.deletedTableColumnWarnings[jsonTableOld + '.' + jsonColumnOld] = true;
                  pullIdxs.push(columnIdx);
                  continue;
                }

                if (jsonColumnOld === 'measurement_time_zone')
                  pullIdxs.push(columnIdx);
                else
                  this.jsonNew['measurements'].columns.push(
                    this.upgradeMap[jsonTableOld][jsonColumnOld][0].column
                  );
                
              }

              // Map the magic_measurements rows into measurements rows.
              let dateIdx = this.jsonOld['magic_measurements'].columns.indexOf('measurement_date');
              let tzIdx   = this.jsonOld['magic_measurements'].columns.indexOf('measurement_time_zone');
              this.jsonNew['measurements'].rows = this.jsonOld['magic_measurements'].rows.map((row) => {

                // Convert dates into ISO 8601 timestamps.
                if (dateIdx >= 0) {
                  let f = "YYYY:MM:DD:hh:mm:ss.SSS";
                  let tz = 'UTC';
                  if (tzIdx >= 0) tz = row[tzIdx];
                  if (tz === 'CDT') tz = 'CST6CDT';
                  if (tz === 'PDT') tz = 'PST8PDT';
                  if (tz === '+8 GMT') tz = 'PRC';
                  if (tz === '0') tz = 'UTC';
                  if (tz === 'SAN') tz = 'US/Pacific';
                  row[dateIdx] = moment.tz(row[dateIdx], f, tz).tz('UTC').format();
                }

                // Remove indexes that should not be part of the measurements table.
                _.pullAt(row, pullIdxs);
                return row;

              });

            }

            rowProgressCounter += this.jsonOld[jsonTableOld].length;
            this.progress = versionIdx * versionPercentProgress + (versionPercentProgress * rowProgressCounter / rowsTotal);
            if (this.onProgress) this.onProgress(this.progress);
            return Promise.resolve();
          }

        }

        // Check that the old table is defined in the old data model.
        if (!this.modelOld['tables'][jsonTableOld]) {
          this._appendError(`Table "${jsonTableOld}" is not defined in MagIC Data Model version ${this.versionOld}.`);
          //console.log('rowProgressCounter', jsonTableOld, rowProgressCounter, this.versionOld, this.jsonOld[jsonTableOld]);
          rowProgressCounter += this.jsonOld[jsonTableOld].length;
          this.progress = versionIdx * versionPercentProgress + (versionPercentProgress * rowProgressCounter / rowsTotal);
          if (this.onProgress) this.onProgress(this.progress);
          //console.log('map progress', this.progress);
          return Promise.resolve();
        }

        // Loop through all rows in table old table.
        const rowIdxChunks = _.chunk(_.range(this.jsonOld[jsonTableOld].length), this.nRowsBetweenProgressEvents);
        if (rowIdxChunks.length === 0)
          return Promise.resolve();

        return Promise.each(rowIdxChunks, rowIdxChunk => {
          return new Promise((resolve) => {
            //_.defer(() => {
            //console.log('before mapping_table_row', jsonTableOld, _.first(rowIdxChunks), 'to', _.last(rowIdxChunks), this.versionOld);
            rowIdxChunk.forEach(rowIdx => {
              this._mapTableRow(jsonTableOld, rowIdx);
              rowProgressCounter++;
              //console.log('after mapping_table_row', jsonTableOld, rowIdx, this.versionOld, '\n', this.jsonOld);
            });
            this.progress = versionIdx * versionPercentProgress + (versionPercentProgress * rowProgressCounter / rowsTotal);
            if (this.onProgress) this.onProgress(this.progress);
            //console.log('map progress', this.progress);
            //_.delay(() => { resolve(); }, 1000);
            //});
            resolve();
          }).delay();
        });

      }).then(() => {
        // Update the data model version.
        if (!this.jsonNew['contribution'])
          this.jsonNew['contribution'] = [{}];
        this.jsonNew['contribution'][0]['magic_version'] = this.versionNew;

        //console.log('done with mapping', this.versionOld, 'to', this.versionNew);
        this.json = this.jsonNew;
        this.jsonOld = this.jsonNew;
        this.versionOld = this.versionNew;
        this.jsonNew = {};

      });

    });

  }

  _mapTableRow(jsonTableOld, jsonRowOldIdx) {

    //console.log('mapping_table_row', jsonTableOld, jsonRowOldIdx, this.versionOld, '\n', this.jsonOld);

    let tableRowsNew = {};
    let joinTable;
    let relativeIntensityNormalization;

    // Make a copy of the row since it might be mutated during the column mapping
    let jsonRowOld = _.cloneDeep(this.jsonOld[jsonTableOld][jsonRowOldIdx]);

    // Handle special cases when upgrading from 2.5 to 3.0 rows.
    if (this.versionNew === '3.0') {

      // Map data into the correct parent table.
      if (jsonTableOld === 'pmag_results' || jsonTableOld === 'rmag_results') {
        if (jsonRowOld['er_synthetic_names'] != null && !jsonRowOld['er_synthetic_names'].match(/.+:.+/))
          joinTable = 'specimens';
        else if (jsonRowOld['er_specimen_names'] != null && !jsonRowOld['er_specimen_names'].match(/.+:.+/))
          joinTable = 'specimens';
        else if (jsonRowOld['er_sample_names']!= null && !jsonRowOld['er_sample_names'].match(/.+:.+/))
          joinTable = 'samples';
        else if (jsonRowOld['er_site_names']!= null && !jsonRowOld['er_site_names'].match(/.+:.+/))
          joinTable = 'sites';
        else if (jsonRowOld['er_location_names']!= null && !jsonRowOld['er_location_names'].match(/.+:.+/))
          joinTable = 'locations';
        else
          this._appendWarning(`Row ${(parseInt(jsonRowOldIdx)+1)} in table "${jsonTableOld}" was deleted in ` +
            `MagIC data model version ${this.versionNew} since it is a contribution-level result.`);
      }

      // Record the type of relative intensity normalization and remove the associated method code.
      if (jsonRowOld['magic_method_codes']) {

        // Make a list of method codes and update their names if necessary.
        let methodCodes = jsonRowOld['magic_method_codes'].replace(/(^:|:$)/g,'').split(/:/);
        methodCodes = methodCodes.map((methodCode) => {
          let mc = methodCode.toUpperCase();
          if (this.newMethodCodes[mc]) mc = this.newMethodCodes[mc];
          return mc;
        });

        // Make a list of relative intensity normalizations in the method codes.
        let relativeIntensityNormalizations = _.intersection(methodCodes, ['IE-ARM', 'IE-IRM', 'IE-CHI']);

        // Remove the relative intensity normalization method code.
        jsonRowOld['magic_method_codes'] = _.without(methodCodes, 'IE-ARM', 'IE-IRM', 'IE-CHI').join(':');

        // Record the type of relative intensity normalization.
        if (relativeIntensityNormalizations.length > 1)
          this._appendError(`Row ${(parseInt(jsonRowOldIdx)+1)} in table "${jsonTableOld}" includes more than one ` +
            `type of relative intensity normalization in the method codes.`);
        else if (relativeIntensityNormalizations.length === 1)
          relativeIntensityNormalization = relativeIntensityNormalizations[0].replace(/IE-/,'');
        else
          relativeIntensityNormalization = undefined;
        // Now relativeIntensityNormalization is undefined or 'ARM' or 'IRM' or 'CHI'.

      }

      // Convert a specimen direction type into a method code.
      if (jsonRowOld['specimen_direction_type']) {
        if (!jsonRowOld['magic_method_codes']) jsonRowOld['magic_method_codes'] = '';
        if (jsonRowOld['specimen_direction_type'].toLowerCase() === 'p')
          jsonRowOld['magic_method_codes'] += ':DE-BFP';
        else
          jsonRowOld['magic_method_codes'] += ':DE-BFL';
        delete jsonRowOld['specimen_direction_type'];
      }

      // Add the geoid to the method codes.
      if (jsonRowOld['location_geoid']) {
        if (!jsonRowOld['magic_method_codes']) jsonRowOld['magic_method_codes'] = '';
        jsonRowOld['magic_method_codes'] += ':GE-' + jsonRowOld['location_geoid'];
      }
      if (jsonRowOld['site_location_geoid']) {
        if (!jsonRowOld['magic_method_codes']) jsonRowOld['magic_method_codes'] = '';
        jsonRowOld['magic_method_codes'] += ':GE-' + jsonRowOld['site_location_geoid'];
      }
      if (jsonRowOld['sample_location_geoid']) {
        if (!jsonRowOld['magic_method_codes']) jsonRowOld['magic_method_codes'] = '';
        jsonRowOld['magic_method_codes'] += ':GE-' + jsonRowOld['sample_location_geoid'];
      }

      // Favor synthetic names over specimen names for natural synthetics.
      if (jsonTableOld === 'er_specimens' &&
        this.syntheticSpecimenNames[jsonRowOld['er_specimen_name']]) {
        if (jsonRowOld['er_specimen_alternatives']) {
          let alternatives = jsonRowOld['er_specimen_alternatives'].replace(/(^:|:$)/g,'').split(/:/);
          alternatives.append(jsonRowOld['er_specimen_name']);
          jsonRowOld['er_specimen_alternatives'] = _.uniq(alternatives).join(':');
        } else {
          jsonRowOld['er_specimen_alternatives'] = jsonRowOld['er_specimen_name'];
        }
        jsonRowOld['er_specimen_name'] = this.syntheticSpecimenNames[jsonRowOld['er_specimen_name']];
      } else if (this.syntheticSpecimenNames[jsonRowOld['er_specimen_name']]) {
        jsonRowOld['er_specimen_name'] = this.syntheticSpecimenNames[jsonRowOld['er_specimen_name']];
      } else if (jsonRowOld['er_specimen_names']) {
        let specimens = jsonRowOld['er_specimen_names'].replace(/(^:|:$)/g, '').split(/:/);
        for (let specimenIdx in specimens) {
          if (this.syntheticSpecimenNames[specimens[specimenIdx]]) {
            specimens[specimenIdx] = this.syntheticSpecimenNames[specimens[specimenIdx]];
          }
        }
        jsonRowOld['er_specimen_names'] = _.uniq(specimens).join(':');
      }

      // Combine the anisotropy tensor elements into a list.
      if (jsonTableOld === 'pmag_results' && joinTable === 'locations' && (
            jsonRowOld['eta_dec'        ] ||
            jsonRowOld['eta_inc'        ] ||
            jsonRowOld['eta_semi_angle' ] ||
            jsonRowOld['zeta_dec'       ] ||
            jsonRowOld['zeta_inc'       ] ||
            jsonRowOld['zeta_semi_angle']
          )) {
        let poleConf = ['','','','','',''];
        if (jsonRowOld['eta_dec'        ]) poleConf[0] = jsonRowOld['eta_dec'        ];
        if (jsonRowOld['eta_inc'        ]) poleConf[1] = jsonRowOld['eta_inc'        ];
        if (jsonRowOld['eta_semi_angle' ]) poleConf[2] = jsonRowOld['eta_semi_angle' ];
        if (jsonRowOld['zeta_dec'       ]) poleConf[3] = jsonRowOld['zeta_dec'       ];
        if (jsonRowOld['zeta_inc'       ]) poleConf[4] = jsonRowOld['zeta_inc'       ];
        if (jsonRowOld['zeta_semi_angle']) poleConf[5] = jsonRowOld['zeta_semi_angle'];
        jsonRowOld['eta_dec'] = poleConf.join(':');
        delete jsonRowOld['eta_inc'        ];
        delete jsonRowOld['eta_semi_angle' ];
        delete jsonRowOld['zeta_dec'       ];
        delete jsonRowOld['zeta_inc'       ];
        delete jsonRowOld['zeta_semi_angle'];
      }

      // Combine the anisotropy tensor elements into a matrix.
      if (jsonTableOld === 'rmag_anisotropy' && (
            jsonRowOld['anisotropy_s1'] ||
            jsonRowOld['anisotropy_s2'] ||
            jsonRowOld['anisotropy_s3'] ||
            jsonRowOld['anisotropy_s4'] ||
            jsonRowOld['anisotropy_s5'] ||
            jsonRowOld['anisotropy_s6']
          )) {
        let anisoS = ['','','','','',''];
        if (jsonRowOld['anisotropy_s1']) anisoS[0] = jsonRowOld['anisotropy_s1'];
        if (jsonRowOld['anisotropy_s2']) anisoS[1] = jsonRowOld['anisotropy_s2'];
        if (jsonRowOld['anisotropy_s3']) anisoS[2] = jsonRowOld['anisotropy_s3'];
        if (jsonRowOld['anisotropy_s4']) anisoS[3] = jsonRowOld['anisotropy_s4'];
        if (jsonRowOld['anisotropy_s5']) anisoS[4] = jsonRowOld['anisotropy_s5'];
        if (jsonRowOld['anisotropy_s6']) anisoS[5] = jsonRowOld['anisotropy_s6'];
        jsonRowOld['anisotropy_s1'] = anisoS.join(':');
        delete jsonRowOld['anisotropy_s2'];
        delete jsonRowOld['anisotropy_s3'];
        delete jsonRowOld['anisotropy_s4'];
        delete jsonRowOld['anisotropy_s5'];
        delete jsonRowOld['anisotropy_s6'];
      }

      // Combine the anisotropy eigenparameters into a matrix.
      for (let i = 1; i <= 3; i++) {
        if (jsonTableOld === 'rmag_results' && (
              jsonRowOld['anisotropy_t' + i                     ] ||
              jsonRowOld['anisotropy_v' + i + '_dec'            ] ||
              jsonRowOld['anisotropy_v' + i + '_inc'            ]
            ) && (
              jsonRowOld['anisotropy_v' + i + '_eta_dec'        ] ||
              jsonRowOld['anisotropy_v' + i + '_eta_inc'        ] ||
              jsonRowOld['anisotropy_v' + i + '_eta_semi_angle' ] ||
              jsonRowOld['anisotropy_v' + i + '_zeta_dec'       ] ||
              jsonRowOld['anisotropy_v' + i + '_zeta_inc'       ] ||
              jsonRowOld['anisotropy_v' + i + '_zeta_semi_angle']
            )) {
          let anisoV = ['', '', '', 'eta/zeta', '', '', '', '', '', ''];
          if (jsonRowOld['anisotropy_t' + i                     ]) anisoV[0] = jsonRowOld['anisotropy_t' + i                     ];
          if (jsonRowOld['anisotropy_v' + i + '_dec'            ]) anisoV[1] = jsonRowOld['anisotropy_v' + i + '_dec'            ];
          if (jsonRowOld['anisotropy_v' + i + '_inc'            ]) anisoV[2] = jsonRowOld['anisotropy_v' + i + '_inc'            ];
          if (jsonRowOld['anisotropy_v' + i + '_eta_dec'        ]) anisoV[4] = jsonRowOld['anisotropy_v' + i + '_eta_dec'        ];
          if (jsonRowOld['anisotropy_v' + i + '_eta_inc'        ]) anisoV[5] = jsonRowOld['anisotropy_v' + i + '_eta_inc'        ];
          if (jsonRowOld['anisotropy_v' + i + '_eta_semi_angle' ]) anisoV[6] = jsonRowOld['anisotropy_v' + i + '_eta_semi_angle' ];
          if (jsonRowOld['anisotropy_v' + i + '_zeta_dec'       ]) anisoV[7] = jsonRowOld['anisotropy_v' + i + '_zeta_dec'       ];
          if (jsonRowOld['anisotropy_v' + i + '_zeta_inc'       ]) anisoV[8] = jsonRowOld['anisotropy_v' + i + '_zeta_inc'       ];
          if (jsonRowOld['anisotropy_v' + i + '_zeta_semi_angle']) anisoV[9] = jsonRowOld['anisotropy_v' + i + '_zeta_semi_angle'];
          jsonRowOld['anisotropy_t' + i] = anisoV.join(':');
          delete jsonRowOld['anisotropy_v' + i + '_dec'            ];
          delete jsonRowOld['anisotropy_v' + i + '_inc'            ];
          delete jsonRowOld['anisotropy_v' + i + '_eta_dec'        ];
          delete jsonRowOld['anisotropy_v' + i + '_eta_inc'        ];
          delete jsonRowOld['anisotropy_v' + i + '_eta_semi_angle' ];
          delete jsonRowOld['anisotropy_v' + i + '_zeta_dec'       ];
          delete jsonRowOld['anisotropy_v' + i + '_zeta_inc'       ];
          delete jsonRowOld['anisotropy_v' + i + '_zeta_semi_angle'];
        }
        else if (jsonTableOld === 'rmag_results' && (
              jsonRowOld['anisotropy_t' + i         ] ||
              jsonRowOld['anisotropy_v' + i + '_dec'] ||
              jsonRowOld['anisotropy_v' + i + '_inc'])
            ) {
          let anisoV = ['', '', ''];
          if (jsonRowOld['anisotropy_t' + i         ]) anisoV[0] = jsonRowOld['anisotropy_t' + i         ];
          if (jsonRowOld['anisotropy_v' + i + '_dec']) anisoV[1] = jsonRowOld['anisotropy_v' + i + '_dec'];
          if (jsonRowOld['anisotropy_v' + i + '_inc']) anisoV[2] = jsonRowOld['anisotropy_v' + i + '_inc'];
          jsonRowOld['anisotropy_t' + i] = anisoV.join(':');
          delete jsonRowOld['anisotropy_v' + i + '_dec'];
          delete jsonRowOld['anisotropy_v' + i + '_inc'];
        }
      }

      // Convert dates into ISO 8601 timestamps.
      if (jsonRowOld['sample'      + '_date'] || jsonRowOld['sample'      + '_time_zone'] ||
          jsonRowOld['image'       + '_date'] || jsonRowOld['image'       + '_time_zone'] ||
          jsonRowOld['plot'        + '_date'] || jsonRowOld['plot'        + '_time_zone']) {
        let f = "YYYY:MM:DD:hh:mm:ss.SSS";
        let tz = 'UTC';
        if (jsonRowOld['sample'      + '_time_zone']) tz = jsonRowOld['sample'      + '_time_zone'];
        if (jsonRowOld['image'       + '_time_zone']) tz = jsonRowOld['image'       + '_time_zone'];
        if (jsonRowOld['plot'        + '_time_zone']) tz = jsonRowOld['plot'        + '_time_zone'];
        if (tz === 'CDT'   ) tz = 'CST6CDT';
        if (tz === 'PDT'   ) tz = 'PST8PDT';
        if (tz === '+8 GMT') tz = 'PRC';
        if (tz === '0'     ) tz = 'UTC';
        if (tz === 'SAN'   ) tz = 'US/Pacific';
        if (jsonRowOld['sample_date'])
          jsonRowOld['sample_date'] = moment.tz(jsonRowOld['sample_date'], f, tz).tz('UTC').format();
        if (jsonRowOld['image_date'])
          jsonRowOld['image_date'] = moment.tz(jsonRowOld['image_date'], f, tz).tz('UTC').format();
        if (jsonRowOld['plot_date'])
          jsonRowOld['plot_date'] = moment.tz(jsonRowOld['plot_date'], f, tz).tz('UTC').format();
        delete jsonRowOld['sample'      + '_time_zone'];
        delete jsonRowOld['image'       + '_time_zone'];
        delete jsonRowOld['plot'        + '_time_zone'];
      }

      // Convert a good/bad intensity scatter into a true/false boolean.
      if (jsonRowOld['specimen_scat'] === 'g') jsonRowOld['specimen_scat'] = 't';
      if (jsonRowOld['specimen_scat'] === 'b') jsonRowOld['specimen_scat'] = 'f';

      // Adopt sample inferred ages up to site ages.
      if (jsonRowOld['er_site_name'] && jsonTableOld === 'pmag_samples' && (
            jsonRowOld['sample_inferred_age'      ] ||
            jsonRowOld['sample_inferred_age_sigma'] ||
            jsonRowOld['sample_inferred_age_low'  ] ||
            jsonRowOld['sample_inferred_age_high' ] ||
            jsonRowOld['sample_inferred_age_unit' ]
          )) {
        let siteRow = {"site": jsonRowOld['er_site_name']};
        if (jsonRowOld['sample_inferred_age'      ]) siteRow['age'      ] = jsonRowOld['sample_inferred_age'      ];
        if (jsonRowOld['sample_inferred_age_sigma']) siteRow['age_sigma'] = jsonRowOld['sample_inferred_age_sigma'];
        if (jsonRowOld['sample_inferred_age_low'  ]) siteRow['age_low'  ] = jsonRowOld['sample_inferred_age_low'  ];
        if (jsonRowOld['sample_inferred_age_high' ]) siteRow['age_high' ] = jsonRowOld['sample_inferred_age_high' ];
        if (jsonRowOld['sample_inferred_age_unit' ]) siteRow['age_unit' ] = jsonRowOld['sample_inferred_age_unit' ];
        if (!this.jsonNew['sites']) this.jsonNew['sites'] = [];
        this.jsonNew['sites'].push(siteRow);
        delete jsonRowOld['sample_inferred_age'      ];
        delete jsonRowOld['sample_inferred_age_sigma'];
        delete jsonRowOld['sample_inferred_age_low'  ];
        delete jsonRowOld['sample_inferred_age_high' ];
        delete jsonRowOld['sample_inferred_age_unit' ];
      }

      // Adopt specimen inferred ages up to site ages.
      if (jsonRowOld['er_site_name'] && jsonTableOld === 'pmag_specimens' && (
            jsonRowOld['specimen_inferred_age'      ] ||
            jsonRowOld['specimen_inferred_age_sigma'] ||
            jsonRowOld['specimen_inferred_age_low'  ] ||
            jsonRowOld['specimen_inferred_age_high' ] ||
            jsonRowOld['specimen_inferred_age_unit' ]
          )) {
        let siteRow = {"site": jsonRowOld['er_site_name']};
        if (jsonRowOld['specimen_inferred_age'      ]) siteRow['age'      ] = jsonRowOld['specimen_inferred_age'      ];
        if (jsonRowOld['specimen_inferred_age_sigma']) siteRow['age_sigma'] = jsonRowOld['specimen_inferred_age_sigma'];
        if (jsonRowOld['specimen_inferred_age_low'  ]) siteRow['age_low'  ] = jsonRowOld['specimen_inferred_age_low'  ];
        if (jsonRowOld['specimen_inferred_age_high' ]) siteRow['age_high' ] = jsonRowOld['specimen_inferred_age_high' ];
        if (jsonRowOld['specimen_inferred_age_unit' ]) siteRow['age_unit' ] = jsonRowOld['specimen_inferred_age_unit' ];
        if (!this.jsonNew['sites']) this.jsonNew['sites'] = [];
        this.jsonNew['sites'].push(siteRow);
        delete jsonRowOld['specimen_inferred_age'      ];
        delete jsonRowOld['specimen_inferred_age_sigma'];
        delete jsonRowOld['specimen_inferred_age_low'  ];
        delete jsonRowOld['specimen_inferred_age_high' ];
        delete jsonRowOld['specimen_inferred_age_unit' ];
      }

      // Adopt sample and specimen average ages up to site ages.
      if (jsonRowOld['er_site_names'] && jsonTableOld === 'pmag_results' &&
          (joinTable === 'samples' || joinTable === 'specimens') && (
            jsonRowOld['average_age'      ] ||
            jsonRowOld['average_age_sigma'] ||
            jsonRowOld['average_age_low'  ] ||
            jsonRowOld['average_age_high' ] ||
            jsonRowOld['average_age_unit' ]
          )) {
        let siteRow = {"site": jsonRowOld['er_site_names']};
        if (jsonRowOld['average_age'      ]) siteRow['age'      ] = jsonRowOld['average_age'      ];
        if (jsonRowOld['average_age_sigma']) siteRow['age_sigma'] = jsonRowOld['average_age_sigma'];
        if (jsonRowOld['average_age_low'  ]) siteRow['age_low'  ] = jsonRowOld['average_age_low'  ];
        if (jsonRowOld['average_age_high' ]) siteRow['age_high' ] = jsonRowOld['average_age_high' ];
        if (jsonRowOld['average_age_unit' ]) siteRow['age_unit' ] = jsonRowOld['average_age_unit' ];
        if (!this.jsonNew['sites']) this.jsonNew['sites'] = [];
        this.jsonNew['sites'].push(siteRow);
        delete jsonRowOld['average_age'      ];
        delete jsonRowOld['average_age_sigma'];
        delete jsonRowOld['average_age_low'  ];
        delete jsonRowOld['average_age_high' ];
        delete jsonRowOld['average_age_unit' ];
      }

      // Insert the default result quality
      if (jsonTableOld === 'pmag_sites'          && jsonRowOld['site_flag'          ] === undefined) jsonRowOld['site_flag'          ] = 'g';
      if (jsonTableOld === 'pmag_samples'        && jsonRowOld['sample_flag'        ] === undefined) jsonRowOld['sample_flag'        ] = 'g';
      if (jsonTableOld === 'pmag_specimens'      && jsonRowOld['specimen_flag'      ] === undefined) jsonRowOld['specimen_flag'      ] = 'g';
      if (jsonTableOld === 'rmag_anisotropy'     && jsonRowOld['anisotropy_flag'    ] === undefined) jsonRowOld['anisotropy_flag'    ] = 'g';
      if (jsonTableOld === 'rmag_hysteresis'     && jsonRowOld['hysteresis_flag'    ] === undefined) jsonRowOld['hysteresis_flag'    ] = 'g';
      if (jsonTableOld === 'rmag_remanence'      && jsonRowOld['remanence_flag'     ] === undefined) jsonRowOld['remanence_flag'     ] = 'g';
      if (jsonTableOld === 'rmag_susceptibility' && jsonRowOld['susceptibility_flag'] === undefined) jsonRowOld['susceptibility_flag'] = 'g';

      // Insert the default result type
      if (jsonTableOld === 'pmag_results' && jsonRowOld['data_type'] === undefined) jsonRowOld['data_type'] = 'i';

    }

    for (let jsonColumnOld in jsonRowOld) {

      // Handle special cases when upgrading from 2.5 to 3.0 columns.
      if (this.versionNew === '3.0') {

        // Don't warn about these columns being deleted when upgrading from 2.5 to 3.0.
        if (!this.upgradeMap[jsonTableOld][jsonColumnOld] && (
          jsonColumnOld === 'er_location_name'      ||
          jsonColumnOld === 'er_site_name'          ||
          jsonColumnOld === 'er_sample_name'        ||
          jsonColumnOld === 'er_specimen_name'      ||
          jsonColumnOld === 'expedition_location'   ||
          jsonColumnOld === 'location_geoid'        ||
          jsonColumnOld === 'site_location_geoid'   ||
          jsonColumnOld === 'sample_location_geoid' ||
          (jsonTableOld === 'rmag_results' && jsonColumnOld === 'er_location_name')))
          continue;

        // Combine external_database_names/ids into a dictionary.
        if (jsonColumnOld === 'external_database_names') {
          let dbNames = jsonRowOld['external_database_names'].replace(/(^:|:$)/g,'').split(/:/);
          let dbIDs = jsonRowOld['external_database_ids'].replace(/(^:|:$)/g,'').split(/:/);
          let dict = [];
          for (let dbIdx in dbNames) {
            dict.push(dbNames[dbIdx] + '[' + dbIDs[dbIdx] + ']');
          }
          jsonRowOld['external_database_names'] = dict.join(':');
        }
        if (jsonColumnOld === 'external_database_ids') continue;

        // Convert the columns in pmag_criteria into rows in the criteria table.
        if (jsonTableOld === 'pmag_criteria') {

          // Create a criteria row if processing a criterion column and not metadata.
          if (jsonColumnOld !== 'pmag_criteria_code' &&
            jsonColumnOld !== 'criteria_definition' &&
            jsonColumnOld !== 'criteria_description' &&
            jsonColumnOld !== 'er_citation_names') {

            // Check that the pmag_criteria column is defined in the data model criteria map.
            if (!this.modelNew['criteria_map'][jsonColumnOld]) {
              if (!this.undefinedTableColumnErrors[jsonTableOld + '.' + jsonColumnOld])
                this._appendError(`Column "${jsonColumnOld}" in table "${jsonTableOld}" ` +
                  `is an unrecognized criteria column in the mapping from MagIC Data Model version ` +
                  `${this.versionOld} to ${this.versionNew}.`);
              this.undefinedTableColumnErrors[jsonTableOld + '.' + jsonColumnOld] = true;
              continue;
            }

            // Create the criteria row.
            let criteriaRow = {};
            criteriaRow['table_column'] = this.modelNew['criteria_map'][jsonColumnOld]['table_column'];
            criteriaRow['criterion_operation'] = this.modelNew['criteria_map'][jsonColumnOld]['criterion_operation'];
            criteriaRow['criterion_value'] = jsonRowOld[jsonColumnOld];
            if (jsonRowOld['pmag_criteria_code'])
              criteriaRow['criterion'] = jsonRowOld['pmag_criteria_code'];
            if (jsonRowOld['criteria_definition'] || jsonRowOld['criteria_description'])
              criteriaRow['description'] =
                (jsonRowOld['criteria_definition'] ? jsonRowOld['criteria_definition'] : '') +
                (jsonRowOld['criteria_definition'] && jsonRowOld['criteria_description'] ? ', ' : '') +
                (jsonRowOld['criteria_description'] ? jsonRowOld['criteria_description'] : '');
            if (jsonRowOld['er_citation_names'])
              criteriaRow['citations'] = jsonRowOld['er_citation_names'];

            // Create the table in the new JSON if it doesn't exist.
            if (!tableRowsNew['criteria']) tableRowsNew['criteria'] = [];

            // Add the criterion row to the criteria table.
            tableRowsNew['criteria'].push(criteriaRow);

          }
          continue;
        }

      }

      // Check that the old column is defined in the old data model.
      if (!this.modelOld['tables'][jsonTableOld]['columns'][jsonColumnOld]) {
        if (!this.undefinedTableColumnErrors[jsonTableOld + '.' + jsonColumnOld])
          this._appendError(`Column "${jsonColumnOld}" in table "${jsonTableOld}" ` +
            `is not defined in MagIC Data Model version ${this.versionOld}.`);
        this.undefinedTableColumnErrors[jsonTableOld + '.' + jsonColumnOld] = true;
        continue;
      }

      // Check that the old table and column are defined in the new data model.
      if (!this.upgradeMap[jsonTableOld] || !this.upgradeMap[jsonTableOld][jsonColumnOld]) {
        if (!this.deletedTableColumnWarnings[jsonTableOld + '.' + jsonColumnOld])
          this._appendWarning(`Column "${jsonColumnOld}" in table "${jsonTableOld}" ` +
            `was deleted in MagIC Data Model version ${this.versionNew}.`);
        this.deletedTableColumnWarnings[jsonTableOld + '.' + jsonColumnOld] = true;
        continue;
      }

      // Cycle through the upgrade info outlining the potential locations in the new model for a single piece of data
      // Go through the location(s) to move ONE field of data from the old model to the proper table in the new
      for (let upgradeToTableAndColumnIdx in this.upgradeMap[jsonTableOld][jsonColumnOld]) {

        let jsonTableNew  = this.upgradeMap[jsonTableOld][jsonColumnOld][upgradeToTableAndColumnIdx].table;
        let jsonColumnNew = this.upgradeMap[jsonTableOld][jsonColumnOld][upgradeToTableAndColumnIdx].column;
        let jsonValueNew  = jsonRowOld[jsonColumnOld];

        if (!joinTable || joinTable === jsonTableNew) {

          // Handle special cases when upgrading from 2.5 to 3.0 columns using the presence or absence of data in groups.
          if (this.versionNew === '3.0') {

            // Move the normalized relative intensities into separate columns.
            if (jsonColumnNew.match(/^int_rel/) && relativeIntensityNormalization)
              jsonColumnNew = jsonColumnNew.replace(/^int_rel/, 'int_rel_' + relativeIntensityNormalization);

            // Combine descriptions without repetition.
            if (jsonColumnNew === 'description' && tableRowsNew[jsonTableNew] &&
              tableRowsNew[jsonTableNew][0][jsonColumnNew] !== undefined) {
              if (tableRowsNew[jsonTableNew][0][jsonColumnNew].indexOf(jsonValueNew) != -1)
                jsonValueNew = tableRowsNew[jsonTableNew][0][jsonColumnNew];
              else if (jsonValueNew.indexOf(tableRowsNew[jsonTableNew][0][jsonColumnNew]) != -1)
                tableRowsNew[jsonTableNew][0][jsonColumnNew] = jsonValueNew;
              else {
                tableRowsNew[jsonTableNew][0][jsonColumnNew] += ', ' + jsonValueNew;
                jsonValueNew = tableRowsNew[jsonTableNew][0][jsonColumnNew];
              }
            }

            // Use the lesser location latitude for lat_s and longitude for lon_w.
            if ((jsonColumnNew === 'lat_s' || jsonColumnNew === 'lon_w') &&
                tableRowsNew[jsonTableNew] &&
                tableRowsNew[jsonTableNew][0][jsonColumnNew] !== undefined) {
              jsonValueNew = Math.min(jsonValueNew, tableRowsNew[jsonTableNew][0][jsonColumnNew]);
              tableRowsNew[jsonTableNew][0][jsonColumnNew] = jsonValueNew;
            }

            // Use the greater location latitude for lat_n and longitude for lon_e.
            if ((jsonColumnNew === 'lat_n' || jsonColumnNew === 'lon_e') &&
                tableRowsNew[jsonTableNew] &&
                tableRowsNew[jsonTableNew][0][jsonColumnNew] !== undefined) {
              jsonValueNew = Math.max(jsonValueNew, tableRowsNew[jsonTableNew][0][jsonColumnNew]);
              tableRowsNew[jsonTableNew][0][jsonColumnNew] = jsonValueNew;
            }

          }

          // Normalize lists for easier comparison in merging by sorting them.
          if (this.modelNew['tables'][jsonTableNew]['columns'][jsonColumnNew].type === 'List' ||
            this.modelNew['tables'][jsonTableNew]['columns'][jsonColumnNew].type === 'Dictionary') {
            jsonValueNew = jsonValueNew.replace(/(^:|:$)/g, '').split(/:/);
            jsonValueNew = _(jsonValueNew).sortBy().sortedUniq().join(':');
          }

          // Add the column value to the new JSON.
          if (!tableRowsNew[jsonTableNew])
            tableRowsNew[jsonTableNew] = [{}];
          if (tableRowsNew[jsonTableNew][0][jsonColumnNew] !== undefined &&
              tableRowsNew[jsonTableNew][0][jsonColumnNew] !== jsonValueNew &&
              this.collisionErrors[`${jsonTableOld}.${jsonColumnOld}`] != `${jsonTableNew}.${jsonColumnNew}`) {
            this._appendError(`MagIC Data Model version ${this.versionOld} column "${jsonColumnOld}" in table ` +
              `"${jsonTableOld}" is about to map value "${jsonValueNew}" into version ${this.versionNew} ` +
              `table "${jsonTableNew}", but column "${jsonColumnNew}" already contains the value ` +
              `"${tableRowsNew[jsonTableNew][0][jsonColumnNew]}".`);
            this.collisionErrors[`${jsonTableOld}.${jsonColumnOld}`] = `${jsonTableNew}.${jsonColumnNew}`;
          } else {
            tableRowsNew[jsonTableNew][0][jsonColumnNew] = jsonValueNew;
          }

        }

      }
    }

    // Add the row(s) to the new JSON.
    for (let table in tableRowsNew) {

      // Handle special cases when upgrading from 2.5 to 3.0 columns.
      if (this.versionNew === '3.0') {
        for (let rowIdx in tableRowsNew[table]) {

          // Insert the 2.5 default orientation quality
          if (table === 'samples' && tableRowsNew[table][rowIdx]['orientation_quality'] === undefined) {
            for (let column in tableRowsNew[table][rowIdx]) {
              if (this.modelNew['tables'][table]['columns'][column].group === 'Orientation') {
                tableRowsNew[table][rowIdx]['orientation_quality'] = 'g';
                break;
              }
            }
          }

          // Insert the 2.5 default direction polarity
          if ((table === 'sites' || table === 'samples' || table === 'specimens') &&
              tableRowsNew[table][rowIdx]['dir_polarity'] === undefined) {
            for (let column in tableRowsNew[table][rowIdx]) {
              if (this.modelNew['tables'][table]['columns'][column].group === 'Direction') {
                tableRowsNew[table][rowIdx]['dir_polarity'] = 'n';
                break;
              }
            }
          }

          // Insert the 2.5 default direction NRM origin
          if ((table === 'sites' || table === 'samples' || table === 'specimens') &&
              tableRowsNew[table][rowIdx]['dir_nrm_origin'] === undefined) {
            for (let column in tableRowsNew[table][rowIdx]) {
              if (this.modelNew['tables'][table]['columns'][column].group === 'Direction') {
                tableRowsNew[table][rowIdx]['dir_nrm_origin'] = 'p';
                break;
              }
            }
          }

          // Insert the 2.5 default direction type
          if (table === 'sites' || table === 'samples' || table === 'specimens') {
            for (let column in tableRowsNew[table][rowIdx]) {
              if (this.modelNew['tables'][table]['columns'][column].group === 'Direction') {
                if (tableRowsNew[table][rowIdx]['method_codes']) {
                  if (!tableRowsNew[table][rowIdx]['method_codes'].match(/(^|(\s*)?:)(\s*)?DE-BF(L|P)/i)) {
                    let methodCodes = tableRowsNew[table][rowIdx]['method_codes'].replace(/(^:|:$)/g, '').split(/:/);
                    methodCodes.push('DE-BFL');
                    tableRowsNew[table][rowIdx]['method_codes'] = _(methodCodes).sortBy().sortedUniq().join(':');
                  }
                } else {
                  tableRowsNew[table][rowIdx]['method_codes'] = 'DE-BFL';
                }
                break;
              }
            }
          }

          // Insert the 2.5 default intensity correction
          if (table === 'specimens' && tableRowsNew[table][rowIdx]['int_corr'] === undefined) {
            for (let column in tableRowsNew[table][rowIdx]) {
              if (this.modelNew['tables'][table]['columns'][column].group === 'Paleointensity') {
                tableRowsNew[table][rowIdx]['int_corr'] = 'u';
                break;
              }
            }
          }

          // Insert the 2.5 default intensity scatter
          if (table === 'specimens' && tableRowsNew[table][rowIdx]['int_scat'] === undefined) {
            for (let column in tableRowsNew[table][rowIdx]) {
              if (this.modelNew['tables'][table]['columns'][column].group === 'Paleointensity Arai Statistics') {
                tableRowsNew[table][rowIdx]['int_scat'] = 't';
                break;
              }
            }
          }

        }
      }

      // Add the row to the new JSON.
      if (!this.jsonNew[table]) this.jsonNew[table] = [];
      this.jsonNew[table] = this.jsonNew[table].concat(tableRowsNew[table]);

    }

  }

  // Merge rows that can be combined because they are orthogonal (null or identical in each column).
  _mergePromise() {

    //console.log('merging', this.json);

    // For each table in the contribution:
    const rowsTotal = _.reduce(this.json, (rowsTotal, table) => {
      return rowsTotal + (table.rows ? table.rows.length : table.length);
    }, 0);
    let rowProgressCounter = 0;

    const tables = _.keys(this.json);
    if (tables.length === 0)
      return Promise.resolve();

    return Promise.each(tables, table => {

      //console.log('merging', table);

      // Skip tables that don't have rows to merge.
      if (table === 'measurements' || table === 'contribution') {
        rowProgressCounter += (this.json[table].rows ? this.json[table].rows.length : this.json[table].length);
        this.progress = 50 + (50 * rowProgressCounter / rowsTotal);
        if (this.onProgress) this.onProgress(this.progress);
        //console.log('merge progress', this.progress);
        return Promise.resolve();
      }

      // Sort the table by the unique composite keys.
      this.json[table] = _.sortBy(this.json[table], this.mergeKeys[table].map((k) => {
        return (o) => (jQuery.isNumeric(o[k]) ? parseFloat(o[k]) : o[k]);
      }));

      // Loop through all rows in the sorted table.
      const rowIdxChunks = _.chunk(_.range(this.json[table].length), this.nRowsBetweenProgressEvents);
      if (rowIdxChunks.length === 0)
        return Promise.resolve();

      return Promise.each(rowIdxChunks, rowIdxs => {
        return new Promise((resolve) => {
          rowIdxs.forEach(rowIdx => {
            this._mergeTableRow(table, rowIdx);
            rowProgressCounter++;
          });
          this.progress = 50 + (50 * rowProgressCounter / rowsTotal);
          if (this.onProgress) this.onProgress(this.progress);
          //console.log('merge progress', this.progress);
          resolve();
        }).delay();
      }).then(() => {
        _.remove(this.json[table], _.isEmpty);
      });

    });

  }

  _mergeTableRow(table, rowIdx) {

    // Skip rows that are empty (e.g. ones that have already been merged).
    if (this.json[table][rowIdx] === undefined) return;

    // Make a list of the columns of the composite keys that are defined in the current row.
    const rowKeys = (this.mergeKeys[table] ? _.pick(this.json[table][rowIdx], this.mergeKeys[table]) : this.json[table][rowIdx]);

    // Make a copy of the row to merge
    const rowToMerge = _.cloneDeep(this.json[table][rowIdx]);
    let didMerge = false;

    // For each following row that is a candidate for merging:
    for (let rowCandidateIdx = rowIdx + 1; rowCandidateIdx < this.json[table].length; rowCandidateIdx++) {

      // Skip rows that are empty (e.g. ones that have already been merged).
      if (this.json[table][rowCandidateIdx] === undefined) continue;

      // Stop merging if the candidate row doesn't share composite key values with the current row.
      // Since the table is sorted, this guarantees that no following rows are candidates for merging.
      if (!_.isMatch(this.json[table][rowCandidateIdx], rowKeys)) break;

      // Make a copy of the current row to test merging with the candidate row.
      //console.log(table, rowIdx, rowKeys, 'should merge?', this.json[table][rowCandidateIdx], 'with', rowToMerge);
      const rowMerged = _.cloneDeep(rowToMerge);

      // Merge the candidate row to test merging with the current row.
      _.merge(rowMerged, this.json[table][rowCandidateIdx]);

      // If the merge didn't mutate any of the existing values in the current row:
      //console.log('data preserved?', rowMerged, 'from', rowToMerge);
      if (_.isMatch(rowMerged, rowToMerge)) {

        // Replace the current row with the merged row.
        //console.log('yes, merged row', rowCandidateIdx, ':', rowToMerge, 'into', rowMerged);
        this.json[table][rowCandidateIdx] = rowMerged;
        didMerge = true;

      }
    }

    // Empty the candidate row so that it is skipped when the current row reaches it without altering the
    // number or rows in the table.
    if (didMerge) this.json[table][rowIdx] = undefined;

  }

  //this.modelNew is the "more recent" of the two models involved in the upgrade process. It is the model we are upgrading the JSON object to.
  //The upgradeMap is "forward looking" from the perspective of the "less recent" (or "current") model in that it shows the path from the less recent model to the "more recent".
  getUpgradeMap(model) {

    let upgradeMap = {};

    for (let newTableName in model.tables) {//this gets the STRING name of the property into 'table'
      let newTableObject = model.tables[newTableName];//this on the other hand, gets the whole table object

      for (let newColumnName in newTableObject.columns)
      {
        let currentColumnObj = newTableObject.columns[newColumnName];
        let prevColArray = currentColumnObj.previous_columns;

        if((prevColArray == undefined) || prevColArray.length==0) {
          continue;
        }

          if (prevColArray &&
              prevColArray.length === 1) {
            let previousColTableName = prevColArray[0].table;
            let previousColumnName = prevColArray[0].column;
            if(!upgradeMap[previousColTableName])                     upgradeMap[previousColTableName] = {};
            if(!upgradeMap[previousColTableName][previousColumnName]) upgradeMap[previousColTableName][previousColumnName] = [];

            //TEST FOR TABLE/COLUMNS WITH NO CHANGES
            if(newColumnName == previousColumnName && newTableName == previousColTableName){
              upgradeMap[previousColTableName][previousColumnName].push({table:newTableName,column:newColumnName});
              //console.log(`NO CHANGE in table and column with no change detected. table:${newTableName}. Column name = ${newColumnName}` );
              continue;
            }

            //TEST FOR RENAMED TABLES OR COLUMNS
            if ((newTableName != previousColTableName) || (newColumnName != previousColumnName)) {
              //console.log(`RENAMED table or column detected. Previous table name : ${previousColTableName} New table: ${newTableName}.` );
              //console.log(`Previous column name = ${previousColumnName}. New column name = ${newColumnName}` );
              upgradeMap[previousColTableName][previousColumnName].push({table:newTableName,column:newColumnName});
              continue;
            }
          }

          //TEST FOR MERGED COLUMNS...If there is more than one previous column, that indicates a MERGE to this version
           if (prevColArray && (prevColArray.length > 1))
          {
            for(let prevColIdx in prevColArray)
            {
              let tmpPreviousColumnName = prevColArray[prevColIdx].column;
              let tmpPreviousColTableName  = prevColArray[prevColIdx].table;

              /*if(!upgradeMap[tmpPreviousColTableName] || upgradeMap[tmpPreviousColTableName]==undefined)
                upgradeMap[tmpPreviousColTableName] = {};
              if(!upgradeMap[tmpPreviousColTableName][tmpPreviousColumnName] || upgradeMap[tmpPreviousColTableName][tmpPreviousColumnName]==undefined)
                upgradeMap[tmpPreviousColTableName][tmpPreviousColumnName] = [];

              upgradeMap[tmpPreviousColTableName][tmpPreviousColumnName].push([{table:newTableName, column:newColumnName}]);*/
              if(!upgradeMap[tmpPreviousColTableName])
                upgradeMap[tmpPreviousColTableName] = {};
              if(!upgradeMap[tmpPreviousColTableName][tmpPreviousColumnName])
                upgradeMap[tmpPreviousColTableName][tmpPreviousColumnName] = [];

              upgradeMap[tmpPreviousColTableName][tmpPreviousColumnName].push({table:newTableName, column:newColumnName});
            }
          }
      }
    }

//console.log(`Upgrade Map ${JSON.stringify(upgradeMap)}`);
    return upgradeMap;

  }
}
