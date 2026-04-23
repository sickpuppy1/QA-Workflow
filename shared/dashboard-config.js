export const DASHBOARD_URL = "http://localhost:3000";
export const DASHBOARD_DEV_URL = "http://localhost:3000";

export const SUPPORT_EMAIL = "support@workflow-automator.io";
export const CHROME_EXTENSION_URL = "https://chromewebstore.google.com";
export const DISCORD_URL = "https://discord.gg/workflowautomator";
export const GITHUB_URL = "https://github.com/restroworks/workflow-automator";

export const DASHBOARD_ALLOWED_ORIGINS = [
  DASHBOARD_URL,
  DASHBOARD_DEV_URL,
];

export function isDashboardUrl(url = "") {
  return DASHBOARD_ALLOWED_ORIGINS.some((origin) => (
    url === origin || url.startsWith(`${origin}/`)
  ));
}
