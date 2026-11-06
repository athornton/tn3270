/**
 * electron-builder 26 configuration for the native GUI artifacts (packaging spec, section 1).
 * Unsigned this milestone. From the repository root:
 *
 *     npm run build && npm run package:gui -- --linux --x64
 *
 * `package:gui` passes `--projectDir packages/gui`; electron-builder looks for
 * `electron-builder.{yml,yaml,json,json5,toml,js,cjs,ts}` in the PROJECT directory
 * (app-builder-lib `util/config/load.js` `findAndReadConfig`), so this file lives here. It is
 * `.cjs`, not `.yml`, for one reason: `beforeBuild` below must be a FUNCTION. A YAML config can
 * only name a hook module by path, and electron-builder resolves that path against the process
 * cwd (`util/resolve.js` `resolveFunction`), not against this file -- so it would break the day
 * anyone ran electron-builder from a different directory.
 *
 * Every key was checked against `node_modules/app-builder-lib/scheme.json` (26.18.0) and, where
 * the behaviour mattered, against its source; the notes say what each one decides.
 */
module.exports = {
  appId: 'io.github.athornton.tn3270',
  // The name users see: window/menu name, .app bundle, install directory, artifact names. It does
  // NOT reach app.getName() by itself -- see `extraMetadata.productName` below.
  productName: 'TN3270',

  directories: {
    // The esbuild bundle (npm run bundle:gui). Its own package.json is the app metadata
    // (name/version/description/author/main); the gui manifest beside this file is the "dev"
    // metadata, which is where the .deb's required homepage comes from (appInfo.computePackageUrl).
    app: 'app',
    output: '../../artifacts/gui',
    buildResources: 'build',
  },

  // Must be explicit: electron is not in app/package.json, and the default reads only
  // node_modules/electron under the project directory or the manifests' dependencies. READ from
  // this package's manifest, never retyped, so the packaged Electron is the one the harnesses
  // test; packages/core/test/manifests.test.ts asserts that dependency is an exact version.
  electronVersion: require('./package.json').dependencies.electron,

  /*
    NO node_modules IN THE APP. The bundle needs none, and app/package.json declares no
    dependencies -- but that is not enough: finding nothing in app/, electron-builder's collector
    moves on to the project directory (packages/gui, whose manifest depends on electron and the
    @tn3270 packages) and then the workspace root (util/appFileCopier.js
    collectNodeModulesWithLogging). MEASURED 2026-11-06 without this hook: app.asar.unpacked held
    291 MB of node_modules/electron, and the asar 659 node_modules entries.
    A beforeBuild that resolves `false` is the documented "dependencies are handled outside
    electron-builder" switch (scheme.json: "Resolving to `false` will skip dependencies install or
    rebuild"); in the source it sets areNodeModulesHandledExternally, which skips that collection
    as well as the pointless @electron/rebuild pass (there is nothing native to rebuild).
  */
  beforeBuild: async () => false,

  asar: true,
  files: ['**/*'],

  // One template for every target, so each file name carries version, OS and arch. Without it the
  // .deb default is `${name}_${version}_${arch}.deb` with `name` = `@tn3270/gui`, and the AppImage
  // and NSIS defaults drop the arch for x64.
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',

  mac: {
    target: [
      { target: 'dmg', arch: 'universal' },
      { target: 'zip', arch: 'universal' },
    ],
    category: 'public.app-category.developer-tools',
    // `null` skips signing entirely (scheme.json MacConfiguration.identity: "**`null`**: skip
    // signing entirely"; unset searches the keychain and would sign with whatever certificate a
    // CI runner happens to hold). The v26 code-signing-mac page gives this or
    // CSC_IDENTITY_AUTO_DISCOVERY=false as the two ways; the config key needs no CI env to remember.
    identity: null,
  },

  linux: {
    // NO `arch` on these targets, on purpose: a target-level arch replaces the command line's
    // --x64/--arm64 (targets/targetFactory.js computeArchToTargetNamesMap), and CI builds each arch
    // on its own native runner with `--linux --x64` / `--linux --arm64`. With no flag: the host's.
    target: ['AppImage', 'deb'],
    category: 'Network',
    maintainer: 'Adam Thornton <athornton@gmail.com>',
    // The .deb control file's one-line synopsis. Without it fpm writes `Description: ` with an
    // empty first line and the whole long description as continuation (measured in dpkg-deb -I).
    synopsis: 'TN3270 terminal emulator for IBM mainframes',
    // The Linux default is the npm name sanitised and lowercased, `@tn3270gui`
    // (linuxPackager.js). Use the npm package's bin name instead.
    executableName: 'tn3270-gui',
    // With `extraMetadata.desktopName` below: the .desktop file is named from desktopName, which
    // Electron also uses as the window's app_id / WM_CLASS, so a desktop links the running window
    // to its launcher (electron-builder 26 warns without it; LinuxTargetHelper.js getDesktopFileName).
    syncDesktopName: true,
  },

  /*
    Merged into the PACKAGED app/package.json only; the bundle's own copy, and the npm package
    built from it, are untouched.

    `productName`: Electron's app.getName() reads package.json `productName`, else `name`, and the
    userData directory is named from it. electron-builder's own `productName` above is NOT written
    into the packaged package.json -- MEASURED 2026-11-06 with XDG_CONFIG_HOME pointed at an empty
    directory: without this line the packaged app created `@tn3270/gui` there, the same directory
    `npx @tn3270/gui` uses (bundle.mjs records that measurement). With it: `TN3270` under the
    platform's appData -- measured on Linux ($XDG_CONFIG_HOME/TN3270); by Electron's documented
    appData rule, ~/Library/Application Support/TN3270 and %APPDATA%\TN3270 (not measured).
  */
  extraMetadata: { productName: 'TN3270', desktopName: 'tn3270-gui.desktop' },

  // The .deb package name defaults to the product name when the npm name is scoped; Debian names are lowercase.
  deb: { packageName: 'tn3270-gui' },

  win: { target: [{ target: 'nsis', arch: 'x64' }] },

  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
  },
};
