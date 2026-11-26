/**
 * UI version string.
 *
 * `__PROGRESS_DEV__` is injected at bundle time by the GUI/TUI builds. Local
 * builds from a commit that is not tagged `plugin@<package version>` get
 * `-dev`; the release workflow checks out the tag, so published bundles are
 * clean without a manual toggle. `PROGRESS_DEV=0|1` overrides detection.
 *
 * The server entry is loaded from source, so this constant is undefined there;
 * `typeof` keeps it safe and the server uses the plain package version.
 */

import pkg from "../package.json";

declare const __PROGRESS_DEV__: boolean | undefined;

export const isDevBuild =
  typeof __PROGRESS_DEV__ !== "undefined" ? __PROGRESS_DEV__ === true : false;

export const packageVersion = pkg.version;
export const displayVersion = `${packageVersion}${isDevBuild ? "-dev" : ""}`;
