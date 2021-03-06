/*
 * Copyright (c) 2018, salesforce.com, inc.
 * All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import * as path from 'path';
import { DeployOptions, mdapiDeployRecentValidation, MetadataTransportInfo } from './mdApiUtil';
import { getObject, getString, isBoolean } from '@salesforce/ts-types';

import { fs } from '@salesforce/core';
import * as archiver from 'archiver';
import * as os from 'os';

// 3pp
import * as BBPromise from 'bluebird';

// Local
import logger = require('salesforce-alm/dist/lib/core/logApi');
import * as almError from 'salesforce-alm/dist/lib/core/almError';
import DeployReport = require('salesforce-alm/dist/lib/mdapi/mdapiDeployReportApi');
import consts = require('salesforce-alm/dist/lib/core/constants');
import StashApi = require('salesforce-alm/dist/lib/core/stash');
import { set } from '@salesforce/kit';
import Stash = require('salesforce-alm/dist/lib/core/stash');

const DEPLOY_ERROR_EXIT_CODE = 1;

// convert params (lowercase) to expected deploy options (camelcase)
const convertParamsToDeployOptions = function({
  rollbackonerror,
  testlevel,
  runtests,
  autoUpdatePackage,
  checkonly,
  ignorewarnings,
  singlepackage,
  purgeondelete
}) {
  const deployOptions: DeployOptions = {};

  deployOptions.rollbackOnError = rollbackonerror;

  if (testlevel) {
    deployOptions.testLevel = testlevel;
  }

  if (runtests) {
    deployOptions.runTests = runtests.split(',');
  }

  if (autoUpdatePackage) {
    deployOptions.autoUpdatePackage = autoUpdatePackage;
  }

  if (ignorewarnings) {
    deployOptions.ignoreWarnings = ignorewarnings;
  }

  if (checkonly) {
    deployOptions.checkOnly = checkonly;
  }

  if (singlepackage) {
    deployOptions.singlePackage = true;
  }

  if (purgeondelete) {
    deployOptions.purgeOnDelete = true;
  }

  return deployOptions;
};

/**
 * API that wraps Metadata API to deploy source - directory or zip - to given org.
 *
 * @param force
 * @constructor
 */
class MdDeployApi {
  private readonly scratchOrg: object;
  private force: any;
  private logger: any;
  private timer: any;
  private _fsStatAsync: any;
  private _reporter: any;
  private loggingEnabled: boolean;
  private readonly stashTarget: string;

  constructor(org, pollIntervalStrategy?, stashTarget: string = StashApi.Commands.MDAPI_DEPLOY) {
    this.scratchOrg = org;
    this.force = org.force;
    this.logger = logger.child('md-deploy');
    this.timer = process.hrtime();
    this._fsStatAsync = BBPromise.promisify(fs.stat);
    // if source:deploy or source:push is the command, create a source report
    if (stashTarget === Stash.Commands.SOURCE_DEPLOY) {
      this._reporter = new DeployReport(org, pollIntervalStrategy, Stash.Commands.SOURCE_DEPLOY);
    } else {
      // create the default mdapi report
      this._reporter = new DeployReport(org, pollIntervalStrategy);
    }
    this.stashTarget = stashTarget;
  }

  _getElapsedTime() {
    const elapsed = process.hrtime(this.timer);
    this.timer = process.hrtime();
    return (elapsed[0] * 1000 + elapsed[1] / 1000000).toFixed(3);
  }

  _zip(dir, zipfile) {
    const file = path.parse(dir);
    const outFile = zipfile || path.join(os.tmpdir() || '.', `${file.base}.zip`);
    const output = fs.createWriteStream(outFile);

    return new BBPromise((resolve, reject) => {
      const archive = archiver('zip', { zlib: { level: 9 } });
      archive.on('end', () => {
        this.logger.debug(`${archive.pointer()} bytes written to ${outFile} using ${this._getElapsedTime()}ms`);
        resolve(outFile);
      });
      archive.on('error', err => {
        this._logError(err);
        reject(err);
      });

      archive.pipe(output);
      archive.directory(dir, file.base);
      archive.finalize();
    });
  }

  _log(message) {
    if (this.loggingEnabled) {
      this.logger.log(message);
    }
  }

  _logError(message) {
    if (this.loggingEnabled) {
      this.logger.error(message);
    }
  }

  _getMetadata({ deploydir, zipfile }) {
    // either zip root dir or pass given zip filepath
    return deploydir ? this._zip(deploydir, zipfile) : zipfile;
  }

  async _sendMetadata(zipPath, options) {
    zipPath = path.resolve(zipPath);

    const zipStream = this._createReadStream(zipPath);

    // REST is the default unless:
    //   1. SOAP is specified with the soapdeploy flag on the command
    //   2. The restDeploy SFDX config setting is explicitly false.
    if (await MetadataTransportInfo.isRestDeploy(options)) {
      this._log('*** Deploying with REST ***');
      return this.force.mdapiRestDeploy(this.scratchOrg, zipStream, convertParamsToDeployOptions(options));
    } else {
      this._log('*** Deploying with SOAP ***');
      return this.force.mdapiSoapDeploy(this.scratchOrg, zipStream, convertParamsToDeployOptions(options));
    }
  }

  _createReadStream(zipPath) {
    return fs.createReadStream(zipPath);
  }

  deploy(options) {
    // Logging is enabled if the output is not json and logging is not disabled
    //set .logginEnabled = true? for source
    this.loggingEnabled = options.source || options.verbose || (!options.json && !options.disableLogging);
    options.wait = +(options.wait || consts.DEFAULT_MDAPI_WAIT_MINUTES);

    // ignoreerrors is a boolean flag and is preferred over the deprecated rollbackonerror flag
    // KEEP THIS code for legacy with commands calling mdapiDeployApi directly.
    if (options.ignoreerrors !== undefined) {
      options.rollbackonerror = !options.ignoreerrors;
    } else if (options.rollbackonerror !== undefined) {
      options.rollbackonerror = options.rollbackonerror;
    } else {
      options.rollbackonerror = true;
    }

    if (options.validateddeployrequestid) {
      return this._doDeployRecentValidation(options);
    }

    return this._doDeploy(options);
  }

  validate(context) {
    const options = context.flags;
    const deploydir = options.deploydir;
    const zipfile = options.zipfile;
    const validateddeployrequestid = options.validateddeployrequestid;
    const validationPromises = [];

    // Wait must be a number that is greater than zero or equal to -1.
    const validWaitValue = !isNaN(+options.wait) && (+options.wait === -1 || +options.wait >= 0);
    if (options.wait && !validWaitValue) {
      return BBPromise.reject(almError('mdapiCliInvalidWaitError'));
    }

    if (options.rollbackonerror && !isBoolean(options.rollbackonerror)) {
      // This should never get called since rollbackonerror is no longer an options
      // but keep for legacy. We want to default to true, so anything that isn't false.
      options.rollbackonerror = options.rollbackonerror.toLowerCase() !== 'false';
    }

    if (!(deploydir || zipfile || validateddeployrequestid)) {
      return BBPromise.reject(almError('MissingRequiredParameter', 'deploydir|zipfile|validateddeployrequestid'));
    }

    if (validateddeployrequestid && !(validateddeployrequestid.length == 18 || validateddeployrequestid.length == 15)) {
      return BBPromise.reject(almError('mdDeployCommandCliInvalidRequestIdError', validateddeployrequestid));
    }

    try {
      MetadataTransportInfo.validateExclusiveFlag(options, 'deploydir', 'jobid');
      MetadataTransportInfo.validateExclusiveFlag(options, 'zipfile', 'jobid');
      MetadataTransportInfo.validateExclusiveFlag(options, 'checkonly', 'jobid');
      MetadataTransportInfo.validateExclusiveFlag(options, 'rollbackonerror', 'ignoreerrors');
      MetadataTransportInfo.validateExclusiveFlag(options, 'soapdeploy', 'jobid');
    } catch (e) {
      return BBPromise.reject(e);
    }

    // Validate required options
    if (deploydir) {
      // Validate that the deploy root is a directory.
      validationPromises.push(
        this._validateFileStat(
          deploydir,
          fileData => fileData.isDirectory(),
          BBPromise.resolve,
          almError('InvalidArgumentDirectoryPath', ['deploydir', deploydir])
        )
      );
    } else if (zipfile) {
      // Validate that the zipfile is a file.
      validationPromises.push(
        this._validateFileStat(
          zipfile,
          fileData => fileData.isFile(),
          BBPromise.resolve,
          almError('InvalidArgumentFilePath', ['zipfile', zipfile])
        )
      );
    }

    return BBPromise.all(validationPromises).then(() => BBPromise.resolve(options));
  }

  // Accepts:
  //     pathToValidate: a file path to validate
  //     validationFunc: function that is called with the result of a fs.stat(), should return true or false
  //     successFunc:    function that returns a promise.
  //     error:          an Error object that will be thrown if the validationFunc returns false.
  // Returns:
  //     Successfull Validation: The result of a call to successFunc.
  //     Failed Validation:      A rejected promise with the specified error, or a PathDoesNotExist
  //                             error if the file read fails.
  _validateFileStat(pathToValidate, validationFunc, successFunc, error) {
    return this._fsStatAsync(pathToValidate)
      .then(data => {
        if (validationFunc(data)) {
          return successFunc();
        } else {
          return BBPromise.reject(error);
        }
      })
      .catch(err => {
        err = err.code === 'ENOENT' ? almError('PathDoesNotExist', pathToValidate) : err;
        return BBPromise.reject(err);
      });
  }

  async _doDeployStatus(result, options) {
    options.deprecatedStatusRequest = options.jobid ? true : false;
    options.jobid = options.jobid || result.id;
    if (await MetadataTransportInfo.isRestDeployWithWaitZero(options)) {
      options.result = result.deployResult;
    } else {
      options.result = result;
      options.result.status = options.result.state;
    }
    return this._reporter.report(options);
  }

  async _setStashVars(result, options) {
    await StashApi.setValues(
      {
        jobid: result.id,
        targetusername: options.targetusername
      },
      this.stashTarget
    );
    return result;
  }

  async _doDeploy(options) {
    try {
      const zipPath = await this._getMetadata(options);
      let sendMetadataResponse;
      if (!options.jobid) {
        sendMetadataResponse = await this._sendMetadata(zipPath, options);
      }
      const stashedVars = await this._setStashVars(sendMetadataResponse, options);
      const deployStats = await this._doDeployStatus(stashedVars, options);
      return await this._throwErrorIfDeployFailed(deployStats);
    } catch (err) {
      if (err.name === 'sf:MALFORMED_ID') {
        throw almError('mdDeployCommandCliInvalidJobIdError', options.jobid);
      } else if (
        options.testlevel !== 'NoTestRun' &&
        getObject(err, 'result.details.runTestResult') &&
        getString(err, 'result.details.runTestResult.numFailures') !== '0'
      ) {
        // if the deployment was running tests, and there were test failures
        err.name = 'testFailure';
        throw err;
      } else {
        throw err;
      }
    }
  }

  async _doDeployRecentValidation(options) {
    let result;
    try {
      if (!options.jobid) {
        let body = await mdapiDeployRecentValidation(this.scratchOrg, options);
        if (options.soapdeploy) {
          result = body;
        } else {
          result = {};
          result.id = body;
          result.state = 'Queued';
        }
      }

      result = await this._setStashVars(result, options);
      result = await this._doDeployStatus(result, options);
      this._throwErrorIfDeployFailed(result);
      return result;
    } catch (err) {
      if (err.name === 'sf:MALFORMED_ID') {
        throw almError('mdDeployCommandCliInvalidJobIdError', options.jobid);
      } else {
        throw err;
      }
    }
  }

  _throwErrorIfDeployFailed(result) {
    if (['Failed', 'Canceled'].includes(result.status)) {
      const err = result.status === 'Canceled' ? almError('mdapiDeployCanceled') : almError('mdapiDeployFailed');
      this._setExitCode(DEPLOY_ERROR_EXIT_CODE);
      set(err, 'result', result);
      return BBPromise.reject(err);
    }
    return BBPromise.resolve(result);
  }

  _setExitCode(code) {
    process.exitCode = code;
  }

  _minToMs(min) {
    return min * 60000;
  }
}

export = MdDeployApi;
