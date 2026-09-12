import { appVersion } from './scripts/app-version.mjs'

export default {
  extends: './electron-builder.json',
  appId: 'com.anddrive.next.beta',
  productName: 'AndDrive Beta',
  directories: {
    output: 'release/beta/${version}',
  },
  extraMetadata: {
    version: appVersion,
  },
}
