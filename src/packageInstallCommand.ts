/*
 * Copyright (c) 2018, salesforce.com, inc.
 * All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

/**
 * Contains config details and operations meant for package subscriber orgs.
 * This could potentially include test orgs used by CI process for testing packages,
 * and target subscriber orgs.
 **/

 import * as BBPromise from 'bluebird';
 import * as _ from 'lodash';
 import * as util from 'util';
 import path = require('path');

 // New messages (move to this)
 import { Messages } from '@salesforce/core';
//  Messages.importMessagesDirectory(__dirname);
 Messages.importMessagesDirectory(path.dirname(require.resolve('salesforce-alm')));

 const packagingMessages = Messages.loadMessages('salesforce-alm', 'packaging');

 // Old style messages
 import MessagesLocal = require('salesforce-alm/dist/lib/messages');
 const messages = MessagesLocal();

 import logger = require('salesforce-alm/dist/lib/core/logApi');
 import pkgUtils = require('salesforce-alm/dist/lib/package/packageUtils');

 const DEFAULT_POLL_INTERVAL_MILLIS = 5000;
 const REPLICATION_POLLING_INTERVAL_MILLIS = 10000;
 const DEFAULT_MAX_RETRIES = 0;
 const RETRY_MINUTES_IN_MILLIS = 60000;
 const DEFAULT_PUBLISH_WAIT_MIN = 0;

 const SECURITY_TYPE_KEY_ALLUSERS = 'AllUsers';
 const SECURITY_TYPE_KEY_ADMINSONLY = 'AdminsOnly';
 const SECURITY_TYPE_VALUE_ALLUSERS = 'full';
 const SECURITY_TYPE_VALUE_ADMINSONLY = 'none';
 const SECURITY_TYPE_MAP = new Map();
 SECURITY_TYPE_MAP.set(SECURITY_TYPE_KEY_ALLUSERS, SECURITY_TYPE_VALUE_ALLUSERS);
 SECURITY_TYPE_MAP.set(SECURITY_TYPE_KEY_ADMINSONLY, SECURITY_TYPE_VALUE_ADMINSONLY);

 const UPGRADE_TYPE_KEY_DELETE = 'Delete';
 const UPGRADE_TYPE_KEY_DEPRECATE_ONLY = 'DeprecateOnly';
 const UPGRADE_TYPE_KEY_MIXED = 'Mixed';
 const UPGRADE_TYPE_VALUE_DELETE = 'delete-only';
 const UPGRADE_TYPE_VALUE_DEPRECATE_ONLY = 'deprecate-only';
 const UPGRADE_TYPE_VALUE_MIXED = 'mixed-mode';
 const UPGRADE_TYPE_MAP = new Map();
 UPGRADE_TYPE_MAP.set(UPGRADE_TYPE_KEY_DELETE, UPGRADE_TYPE_VALUE_DELETE);
 UPGRADE_TYPE_MAP.set(UPGRADE_TYPE_KEY_DEPRECATE_ONLY, UPGRADE_TYPE_VALUE_DEPRECATE_ONLY);
 UPGRADE_TYPE_MAP.set(UPGRADE_TYPE_KEY_MIXED, UPGRADE_TYPE_VALUE_MIXED);

 const APEX_COMPILE_KEY_ALL = 'all';
 const APEX_COMPILE_KEY_PACKAGE = 'package';
 const APEX_COMPILE_VALUE_ALL = 'all';
 const APEX_COMPILE_VALUE_PACKAGE = 'package';
 const APEX_COMPILE_MAP = new Map();
 APEX_COMPILE_MAP.set(APEX_COMPILE_KEY_ALL, APEX_COMPILE_VALUE_ALL);
 APEX_COMPILE_MAP.set(APEX_COMPILE_KEY_PACKAGE, APEX_COMPILE_VALUE_PACKAGE);

 /**
  * Private utility to parse out errors from PackageInstallRequest as a user-readable string.
  */
 const readInstallErrorsAsString = function(request) {
   if (request.Errors && request.Errors.errors) {
     const errorsArray = request.Errors.errors;
     const len = errorsArray.length;
     if (len > 0) {
       let errorMessage = 'Installation errors: ';
       for (let i = 0; i < len; i++) {
         errorMessage += `\n${i + 1}) ${errorsArray[i].message}`;
       }
       return errorMessage;
     }
   }
   return '<empty>';
 };

 class PackageInstallCommand {
   // TODO: proper property typing
   [property: string]: any;

   constructor(stdinPrompt?) {
     this.pollIntervalMillis = DEFAULT_POLL_INTERVAL_MILLIS;
     this.replicationPollIntervalMillis = REPLICATION_POLLING_INTERVAL_MILLIS;
     this.maxRetries = DEFAULT_MAX_RETRIES;
     this.allPackageVersionId = null;
     this.installationKey = null;
     this.publishwait = DEFAULT_PUBLISH_WAIT_MIN;
     this.logger = logger.child('PackageInstallCommand');
     this.stdinPrompt = stdinPrompt;
     this.packageInstallRequest = {};
   }

   poll(context, id, retries) {
     this.org = context.org;
     this.configApi = this.org.config;
     this.force = this.org.force;

     return this.force.toolingRetrieve(this.org, 'PackageInstallRequest', id).then(request => {
       switch (request.Status) {
         case 'SUCCESS':
           return request;
         case 'ERROR': {
           const err = readInstallErrorsAsString(request);
           this.logger.error('Encountered errors installing the package!', err);
           throw new Error(err);
         }
         default:
           if (retries > 0) {
             // Request still in progress.  Just log a message and move on. Server will be polled again.
             this.logger.log(messages.getMessage('installStatus', request.Status, 'packaging'));
             return BBPromise.delay(this.pollIntervalMillis).then(() => this.poll(context, id, retries - 1));
           } else {
             // timed out
           }
       }
       return request;
     });
   }

   async _waitForApvReplication(remainingRetries) {
     const QUERY_NO_KEY =
       'SELECT Id, SubscriberPackageId, InstallValidationStatus FROM SubscriberPackageVersion' +
       ` WHERE Id ='${this.allPackageVersionId}'`;

     const escapedInstallationKey =
       this.installationKey != null ? this.installationKey.replace(/\\/g, '\\\\').replace(/\'/g, "\\'") : null;
     const QUERY_W_KEY =
       'SELECT Id, SubscriberPackageId, InstallValidationStatus FROM SubscriberPackageVersion' +
       ` WHERE Id ='${this.allPackageVersionId}' AND InstallationKey ='${escapedInstallationKey}'`;

     let queryResult = null;
     try {
       queryResult = await this.force.toolingQuery(this.org, util.format(QUERY_W_KEY));
     } catch (e) {
       // Check first for Implementation Restriction error that is enforced in 214, before it was possible to query
       // against InstallationKey, otherwise surface the error.
       if (pkgUtils.isErrorFromSPVQueryRestriction(e)) {
         queryResult = await this.force.toolingQuery(this.org, util.format(QUERY_NO_KEY));
       } else {
         if (!pkgUtils.isErrorPackageNotAvailable(e)) {
           throw e;
         }
       }
     }

     // Continue retrying if there is no record
     // or for an InstallValidationStatus of PACKAGE_UNAVAILABLE (replication to the subscriber's instance has not completed)
     // or for an InstallValidationStatus of UNINSTALL_IN_PROGRESS
     let installValidationStatus = null;
     if (queryResult && queryResult.records && queryResult.records.length > 0) {
       installValidationStatus = queryResult.records[0].InstallValidationStatus;
       if (installValidationStatus != 'PACKAGE_UNAVAILABLE' && installValidationStatus != 'UNINSTALL_IN_PROGRESS') {
         return queryResult.records[0];
       }
     }

     if (remainingRetries <= 0) {
       // There are no more reties.  Throw an error indicating the package is unavailable.
       // For UNINSTALL_IN_PROGRESS, though, allow install to proceed which will result in an appropriate UninstallInProgressProblem
       // error message being displayed.
       if (installValidationStatus == 'UNINSTALL_IN_PROGRESS') {
         return null;
       } else {
         throw new Error(messages.getMessage('errorApvIdNotPublished', [], 'package_install'));
       }
     }
     return BBPromise.delay(this.replicationPollIntervalMillis).then(() => {
       this.logger.log(messages.getMessage('publishWaitProgress', [], 'package_install'));
       return this._waitForApvReplication(remainingRetries - 1);
     });
   }

   /**
    * This installs a package version into a target org.
    * @param context: heroku context
    * @returns {*|promise}
    */
   async execute(context) {
     this.org = context.org;
     this.configApi = this.org.config;
     this.force = this.org.force;

     // either of the id or package flag is required, not both at the same time
     if ((!context.flags.id && !context.flags.package) || (context.flags.id && context.flags.package)) {
       const idFlag = context.command.flags.find(x => x.name === 'id');
       const packageFlag = context.command.flags.find(x => x.name === 'package');
       throw new Error(
         messages.getMessage(
           'errorRequiredFlags',
           [`--${idFlag.name} (-${idFlag.char})`, `--${packageFlag.name}`],
           'package_install'
         )
       );
     }

     let apvId;
     if (context.flags.id) {
       apvId = context.flags.id;
     } else if (context.flags.package) {
       // look up the alias only when it's not a 04t
       apvId = context.flags.package.startsWith(pkgUtils.BY_LABEL.SUBSCRIBER_PACKAGE_VERSION_ID.prefix)
         ? context.flags.package
         : pkgUtils.getPackageIdFromAlias(context.flags.package, this.force);
     }

     // validate whatever is set as the apvId, even if that might be a bunk alias
     try {
       pkgUtils.validateId(pkgUtils.BY_LABEL.SUBSCRIBER_PACKAGE_VERSION_ID, apvId);
     } catch (err) {
       throw new Error(messages.getMessage('invalidIdOrPackage', apvId, 'package_install'));
     }

     this.allPackageVersionId = apvId;
     this.maxRetries = _.isNil(context.flags.wait)
       ? this.maxRetries
       : (RETRY_MINUTES_IN_MILLIS / this.pollIntervalMillis) * context.flags.wait;

     // Be careful with the fact that cmd line flags are NOT camel cased: flags.installationkey
     this.installationKey = _.isNil(context.flags.installationkey)
       ? this.installationKey
       : context.flags.installationkey;

     this.publishwait = _.isNil(context.flags.publishwait) ? this.publishwait : context.flags.publishwait;

     const apiVersion = this.configApi.getApiVersion();

     if (apiVersion < 36) {
       throw new Error('This command is supported only on API versions 36.0 and higher');
     }

     const publishWaitRetries = Math.ceil(
       (parseInt(this.publishwait) * 60 * 1000) / parseInt(this.replicationPollIntervalMillis)
     );

     await this._waitForApvReplication(publishWaitRetries);

     const pkgType = await pkgUtils.getPackage2TypeBy04t(apvId, this.force, this.org, this.installationKey);

     // If the user has specified --upgradetype Delete, then prompt for confirmation
     // unless the noprompt option has been included
     if (context.flags.upgradetype == UPGRADE_TYPE_KEY_DELETE && pkgType === 'Unlocked') {
       // don't prompt if we're going to ignore anyway
       const accepted = await this._prompt(
         context.flags.noprompt,
         messages.getMessage('promptUpgradeType', [], 'package_install')
       );
       if (!accepted) {
         throw new Error(messages.getMessage('promptUpgradeTypeDeny', [], 'package_install'));
       }
     }

     // If the user is installing an unlocked package with external sites (RSS/CSP) then
     // inform and prompt the user of these sites for acknowledgement.
     const externalSiteData = await this._getExternalSites(this.allPackageVersionId);
     let enableExternalSites = false;

     if (externalSiteData.trustedSites && externalSiteData.trustedSites.length > 0) {
       const accepted = await this._prompt(
         context.flags.noprompt,
         messages.getMessage('promptRss', externalSiteData.trustedSites.join('\n'), 'package_install')
       );
       if (accepted) {
         enableExternalSites = true;
       }
     }

     // Construct PackageInstallRequest sobject used to trigger package version install.
     this.packageInstallRequest.subscriberPackageVersionKey = this.allPackageVersionId;
     this.packageInstallRequest.password = this.installationKey; // W-3980736 in the future we hope to change "Password" to "InstallationKey" on the server
     if (context.flags.upgradetype !== UPGRADE_TYPE_KEY_MIXED) {
       if (pkgType === 'Unlocked') {
         // include upgradetype if it's not the default value 'mixed'
         this.packageInstallRequest.upgradeType = UPGRADE_TYPE_MAP.get(context.flags.upgradetype);
       } else {
         this.logger.log(packagingMessages.getMessage('install.warningUpgradeTypeOnlyForUnlocked'));
       }
     }
     if (context.flags.apexcompile !== APEX_COMPILE_KEY_ALL) {
       if (pkgType === 'Unlocked') {
         // include apexcompile if it's not the default value 'all'
         this.packageInstallRequest.apexCompileType = APEX_COMPILE_MAP.get(context.flags.apexcompile);
       } else {
         this.logger.log(packagingMessages.getMessage('install.warningApexCompileOnlyForUnlocked'));
       }
     }

     // Add default parameters to input object.
     this.packageInstallRequest.securityType = SECURITY_TYPE_MAP.get(context.flags.securitytype);
     this.packageInstallRequest.nameConflictResolution = 'Block';
     this.packageInstallRequest.packageInstallSource = 'U';
     this.packageInstallRequest.enableRss = enableExternalSites;
     if (context.flags.automapprofiles) {
      this.packageInstallRequest.profileMappings = await this._getProfileMappings();
     }

     const result = await this.force.toolingCreate(this.org, 'PackageInstallRequest', this.packageInstallRequest);

     const packageInstallRequestId = result.id;
     if (_.isNil(packageInstallRequestId)) {
       throw new Error(`Failed to create PackageInstallRequest for: ${this.allPackageVersionId}`);
     }
     return this.poll(context, packageInstallRequestId, this.maxRetries);
   }

   async _prompt(noninteractive, message) {
     const answer = noninteractive ? 'YES' : await this.stdinPrompt(message);
     // print a line of white space after the prompt is entered for separation
     this.logger.log('');
     return answer.toUpperCase() === 'YES' || answer.toUpperCase() === 'Y';
   }

   /**
    * Returns all RSS/CSP external third party websites
    * @param allPackageVersionId
    * @returns {object}
    *
    * {
    *   unlocked: boolean,
    *   trustedSites: [string]
    * }
    */
   async _getExternalSites(allPackageVersionId) {
     const subscriberPackageValues: any = {};
     const query_no_key =
       'SELECT RemoteSiteSettings, CspTrustedSites ' +
       'FROM SubscriberPackageVersion ' +
       `WHERE Id ='${allPackageVersionId}'`;

     const escapedInstallationKey =
       this.installationKey != null ? this.installationKey.replace(/\\/g, '\\\\').replace(/\'/g, "\\'") : null;
     const query_w_key =
       'SELECT RemoteSiteSettings, CspTrustedSites ' +
       'FROM SubscriberPackageVersion ' +
       `WHERE Id ='${allPackageVersionId}' AND InstallationKey ='${escapedInstallationKey}'`;

     let queryResult = null;
     try {
       queryResult = await this.force.toolingQuery(this.org, query_w_key);
     } catch (e) {
       // Check first for Implementation Restriction error that is enforced in 214, before it was possible to query
       // against InstallationKey, otherwise surface the error.
       if (pkgUtils.isErrorFromSPVQueryRestriction(e)) {
         queryResult = await this.force.toolingQuery(this.org, query_no_key);
       } else {
         throw e;
       }
     }

     if (queryResult.records && queryResult.records.length > 0) {
       const record = queryResult.records[0];
       const rssUrls = record.RemoteSiteSettings.settings.map(rss => rss.url);
       const cspUrls = record.CspTrustedSites.settings.map(csp => csp.endpointUrl);

       subscriberPackageValues.trustedSites = rssUrls.concat(cspUrls);
     }

     return subscriberPackageValues;
   }

   async _getProfileMappings() {
      const QUERY_NO_KEY =
        'SELECT Profiles FROM SubscriberPackageVersion' +
        ` WHERE Id ='${this.allPackageVersionId}'`;

      const escapedInstallationKey =
        this.installationKey != null ? this.installationKey.replace(/\\/g, '\\\\').replace(/\'/g, "\\'") : null;
      const QUERY_W_KEY =
        'SELECT Profiles FROM SubscriberPackageVersion' +
        ` WHERE Id ='${this.allPackageVersionId}' AND InstallationKey ='${escapedInstallationKey}'`;

      let queryResult = null;
      try {
        queryResult = await this.force.toolingQuery(this.org, util.format(QUERY_W_KEY));
      } catch (e) {
        // Check first for Implementation Restriction error that is enforced in 214, before it was possible to query
        // against InstallationKey, otherwise surface the error.
        if (pkgUtils.isErrorFromSPVQueryRestriction(e)) {
          queryResult = await this.force.toolingQuery(this.org, util.format(QUERY_NO_KEY));
        } else {
          if (!pkgUtils.isErrorPackageNotAvailable(e)) {
            throw e;
          }
        }
      }

      const result = queryResult.records[0];
      const regexNoProfile = /^__.*__$/;
      const sourceProfiles = result?.Profiles?.sourceProfiles?.filter(x => !regexNoProfile.test(x.value)).map(x => x.value);
      const profileMappings = [];
      this.logger.log(`Trying to map ${sourceProfiles.length} Profiles: ${JSON.stringify(sourceProfiles)}`);
      const unmappedProfiles = [];
      for (const sourceProfile of sourceProfiles) {
        const destinationProfile = result?.Profiles?.destinationProfiles.find(x => x.name === sourceProfile);
        if (destinationProfile?.profileId) {
          profileMappings.push({
            source: destinationProfile.profileId,
            target: sourceProfile
          })
        } else {
          unmappedProfiles.push(sourceProfile);
        }
      }
      if (unmappedProfiles.length > 0) {
        this.logger.log(`WARN: Could not find the following Profiles in your org: ${JSON.stringify(unmappedProfiles)}`)
      }
      return {
        profileMappings
      }
    }

   /**
    * returns a human readable message for a cli output
    * @returns {string}
    */
   getHumanSuccessMessage(result) {
     switch (result.Status) {
       case 'SUCCESS':
         return messages.getMessage(result.Status, [result.SubscriberPackageVersionKey], 'package_install_report');
       case 'TERMINATED':
         return '';
       default:
         return messages.getMessage(result.Status, [result.Id, this.org.name], 'package_install_report');
     }
   }
 }

 export = PackageInstallCommand;
