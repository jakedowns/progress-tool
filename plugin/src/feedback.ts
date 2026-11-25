/**
 * Feedback link for the desktop pill footer.
 *
 * GitHub's /issues/new accepts a `title` query parameter, so the plugin
 * version can ride along in the issue title instead of being retyped by
 * whoever reports a bug or asks for a feature.
 */

const ISSUE_URL = "https://github.com/jakedowns/progress-tool/issues/new";

export function feedbackIssueUrl(version: string): string {
  return `${ISSUE_URL}?title=${encodeURIComponent(`[Feedback] v${version}`)}`;
}

const RELEASES_URL = "https://github.com/jakedowns/progress-tool/releases";

/** Changelog/releases page for the version link in the tree footer. */
export function releasesUrl(): string {
  return RELEASES_URL;
}
