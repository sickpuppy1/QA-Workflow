export const DASHBOARD_URL = "http://localhost:3000";
export const DASHBOARD_DEV_URL = "http://localhost:3000";

export const DASHBOARD_ALLOWED_ORIGINS = [
  DASHBOARD_URL,
  DASHBOARD_DEV_URL,
];

export function isDashboardUrl(url = "") {
  return DASHBOARD_ALLOWED_ORIGINS.some((origin) => (
    url === origin || url.startsWith(`${origin}/`)
  ));
}
