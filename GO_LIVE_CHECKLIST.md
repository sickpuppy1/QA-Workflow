# Go-Live Checklist: Extension + Dashboard

This is the safest order to make the dashboard live on Vercel while moving it into a separate repository.

## 1. Freeze the current state

- [ ] Keep this repo clean and tag or note the last known-good combined version.
- [ ] Do not change extension and dashboard at the same time unless the change is required for integration.

## 2. Create a separate dashboard repo first

- [ ] Create a new repository for the contents of `/dashboard`.
- [ ] Copy only the dashboard app files, not the extension files.
- [ ] Remove build artifacts before the first commit:
  - `dashboard/.next`
  - `dashboard/node_modules`
  - `dashboard/npm-debug.log`
- [ ] Keep `.env*` out of Git.
- [ ] Add a `.env.example` in the new dashboard repo with placeholder keys only.

## 3. Make the dashboard self-contained before deploy

Status:
- Done. Dashboard-side constants were moved into `dashboard/lib/site-config.ts`.

Files updated:
- `dashboard/app/contact/page.tsx`
- `dashboard/app/landing/page.tsx`
- `dashboard/app/privacy/page.tsx`
- `shared/dashboard-config.js`

Checklist:
- [x] Move dashboard-specific constants into the dashboard repo itself.
- [x] Replace imports that currently depend on `@/../shared/dashboard-config`.
- [x] Keep only extension-side URL config in the extension repo.

## 4. Make the dashboard Vercel-ready

Status:
- Node target updated to `22.x`.
- Dashboard build passes locally on a newer Node install.
- The remaining requirement is environment setup for Vercel.

Checklist:
- [x] Change `engines.node` in the dashboard repo to a Vercel-supported major version such as `20.x`, `22.x`, or `24.x`.
- [x] Confirm the app still builds locally after that change.
- [ ] Keep these environment variables ready for Vercel:
  - `MONGODB_URI`
  - `MONGODB_DB_NAME`
  - `JWT_SECRET`
  - `NEXT_PUBLIC_DASHBOARD_URL`
- [ ] Remove unused secrets from Vercel if they are not actually used by the app.
- [ ] Rotate any secrets that may have already been copied around insecurely.

## 5. Deploy the dashboard to Vercel

- [ ] Push the new dashboard repo to GitHub.
- [ ] In Vercel, create a new project from that repo.
- [ ] Set the production branch you want to deploy from, usually `main`.
- [ ] Add the required environment variables in Vercel before the production deploy.
- [ ] Create one preview deployment first.
- [ ] Test signup, login, workflow listing, workflow detail pages, settings, and API routes on the preview URL.
- [ ] Promote or merge to production only after the preview passes.

## 6. Point the extension to the live dashboard

Current blocker:
- The extension is hardcoded to `http://localhost:3000`.

File to fix:
- `shared/dashboard-config.js`

Checklist:
- [ ] Replace `DASHBOARD_URL` with the real Vercel production URL.
- [ ] Keep a development URL path for local testing if you still need localhost.
- [ ] Update allowed origins so auth sync works on both local and production dashboard URLs.
- [ ] Verify the extension login bridge still works against the deployed dashboard.

## 7. Smoke test the full live flow

- [ ] Sign up from the live dashboard.
- [ ] Sign in from the extension popup.
- [ ] Record a workflow and confirm it saves to the dashboard.
- [ ] Load dashboard workflows back into the popup.
- [ ] Run a playback and confirm run data uploads to the dashboard.
- [ ] Confirm settings sync between dashboard and extension.
- [ ] Confirm logout clears auth in both places.

## 8. Publish the extension only after the dashboard is stable

- [ ] Bump the extension version in `manifest.json`.
- [ ] Build/package the extension submission.
- [ ] Update store listing text/screenshots if needed.
- [ ] Submit the extension only after the production dashboard URL is final.

## Recommended execution order

1. Split `/dashboard` into a new repo.
2. Make the dashboard repo self-contained.
3. Fix Node version and environment setup.
4. Deploy the dashboard to Vercel.
5. Test the deployed dashboard on a preview and production URL.
6. Update the extension to use the live dashboard URL.
7. End-to-end test extension + dashboard together.
8. Publish the updated extension.

## Notes from the current codebase

- Extension dashboard URL is still set to localhost in `shared/dashboard-config.js`.
- Dashboard constants now live in `dashboard/lib/site-config.ts`.
- Dashboard Node engine is now `22.x` in `dashboard/package.json`.
- MongoDB is required by `dashboard/lib/mongodb.ts`.
- JWT secret is required by `dashboard/lib/jwt.ts`.

## Useful Vercel docs

- Git deployments: https://vercel.com/docs/deployments/git
- Environment variables: https://vercel.com/docs/environment-variables
- Project settings: https://vercel.com/docs/project-configuration/project-settings
- Supported Node.js versions: https://vercel.com/docs/functions/runtimes/node-js/node-js-versions
