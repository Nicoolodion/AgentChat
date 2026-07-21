/**
 * Single source of truth for the displayed app version.
 *
 * Bump this manually when shipping a release:
 *   - bugfix-only  -> tick the patch number (e.g. v0.1 -> v0.1.1)
 *   - new feature  -> tick the minor number (e.g. v0.1 -> v0.2)
 *
 * It is rendered as a fixed badge in the bottom-right corner of the webui
 * (see src/app/layout.tsx) and nowhere else, so you can always tell which
 * build is live.
 */
export const APP_VERSION = "v0.8.12";
