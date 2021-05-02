# sfdx-patches

> temporary patches for basic sfdx commands (salesforce-alm)

For now the basic sfdx commands (`sfdx force:*`) are mostly available only in a read-only repository ([salesforce-alm](https://github.com/forcedotcom/salesforce-alm)).
The objective of `sfdx-patches` is to inofficially serve some patches until sfdx is fully open source and Pull Requests can be submitted.

[![Actions Status](https://github.com/amtrack/sfdx-patches/workflows/Release/badge.svg)](https://github.com/amtrack/sfdx-patches/actions)

## Installation

```console
sfdx plugins:install sfdx-patches
```

## Features

This plugin currently provides patches for the following basic commands:

- `sfdx package:install`
- `sfdx mdapi:deploy`

### package:install

added flags

- `--automapprofiles`: automatically map profiles based on their name

Usage: `sfdx patched:package:install --automapprofiles`

Thanks to David Reed and Jeff for providing the inspiration for this solution:

- https://salesforce.stackexchange.com/questions/336066/sfdx-or-api-call-to-install-package-using-profile-mapping/336067#336067
- https://salesforce.stackexchange.com/questions/237824/how-do-i-specify-profile-mappings-on-a-packageinstallrequest

### mdapi:deploy

added flags

- `--purgeondelete`: don't store deleted components in the recycle bin

Usage: `sfdx patched:mdapi:deploy --purgeondelete`
