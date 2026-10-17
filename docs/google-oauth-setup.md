# Setting up Google sign-in

CampusCart signs users in with Google using the server-side **Authorization Code flow with PKCE**.
Until the three Google variables below are set, the login page says "Google sign-in isn't
configured", and only the developer login (if enabled) works.

> **Status:** the Google flow is implemented and covered by automated tests that use a fake Google.
> **Real sign-in with Google has not been tested yet**, because it needs credentials from your
> Google Cloud project. Follow this guide, then run the manual test at the end.

## 1. Create a Google Cloud project

1. Open <https://console.cloud.google.com/> and sign in.
2. Use the project picker at the top and choose **New project**. Name it e.g. `CampusCart`, then
   create it and select it.

## 2. Configure the OAuth consent screen

1. Go to **APIs & Services → OAuth consent screen**. In newer consoles this is **Google Auth
   Platform → Branding / Audience / Data access**.
2. **User type / Audience:** choose **External**, so any Google account can sign in, not just
   one organisation.
3. **App information:** app name `CampusCart`, your support email, and developer contact email.
4. **Scopes / Data access:** add only `openid`, `.../auth/userinfo.email` and
   `.../auth/userinfo.profile`. These are non-sensitive scopes. CampusCart asks for nothing else.
5. **Test users:** while the app is in **Testing** status, only the accounts listed here can sign
   in, up to 100. Add the Google accounts you'll test with, for example
   `singlahimanshi2@gmail.com`.

### Publishing (needed so _any_ Google account can register)

Students must be able to register with any Google account. That only works once the consent screen
is **published** ("In production"). In Testing mode everyone else sees an "access blocked" error.

- With only the three basic scopes above, Google normally doesn't require a full app
  verification review. It may still ask for brand verification (app name, logo, home page and
  privacy policy URLs, verified domain) before showing your logo.
- Google's requirements change from time to time. Check the current rules on the console's
  Verification Center page before publishing.

## 3. Create the OAuth client

1. Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. **Application type:** Web application. **Name:** `CampusCart web`.
3. **Authorised JavaScript origins:**
   - Local: `http://localhost:5173`
   - Production: your site's origin, e.g. `https://campuscart.example.edu`
4. **Authorised redirect URIs**, which must match `GOOGLE_CALLBACK_URL` exactly:
   - Local: `http://localhost:5173/api/v1/auth/google/callback`
   - Production: `https://campuscart.example.edu/api/v1/auth/google/callback`
5. Create it, then copy the **Client ID** and **Client secret**.

Why port 5173 locally? In development the browser only talks to the Vite dev server, which
forwards `/api` to the backend on port 4000. That keeps the sign-in cookies on one origin.

## 4. Configure CampusCart

Put the values in `backend/.env`. **Never** put them in `frontend/.env`: anything `VITE_*` is
visible to every visitor.

```
GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
GOOGLE_CALLBACK_URL=http://localhost:5173/api/v1/auth/google/callback
FRONTEND_URL=http://localhost:5173
```

Restart the backend (`npm run dev`). `GET /api/v1/auth/providers` should now return
`"google": true`.

In production all three Google variables are **required**; the server refuses to start without
them. It also refuses to start if `DEV_LOGIN_ENABLED` or `PAYMENT_MOCK_ENABLED` is `true`.

## 5. Manual test of real Google sign-in

1. Make sure the Google account you'll use is a **test user** (or the app is published).
2. **Important:** if you've used the _developer login_ with that same email address in your
   local database, Google sign-in for that address will be refused with "Another CampusCart
   account already uses this email address". That's the intended no-auto-linking rule. Use a
   different email for the developer login.
3. Open <http://localhost:5173/login> and click **Continue with Google**.
4. Choose your account. You should land back on CampusCart, signed in. Your name appears in the
   header and the profile page shows **Student**, plus **Manager** and **POS / Cashier** if your
   email is in the allowlists.
5. Check the failure paths:
   - Press "Cancel" on Google's screen: you should see "Sign-in was cancelled".
   - Use the browser's Back button to replay the callback URL: you should see "That sign-in link
     expired or was already used".
6. Click **Sign out** and confirm `/profile` sends you to the login page again.

Record the result in the phase report. Until this has been done, real Google sign-in is
**unverified**.

## Changing the Manager / POS allowlists

`MANAGER_ALLOWED_EMAILS` and `POS_ALLOWED_EMAILS` in `backend/.env` are comma-separated and
case-insensitive. Edit them and restart the backend. No code changes are needed.

What a change does, and doesn't do (approved decision Q4):

| Situation                                        | Result                                                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| New account, verified email on a list            | Gets that role when the account is first created                                                                         |
| New account, email on **both** lists             | Gets both Manager and POS (and Student)                                                                                  |
| New account, Google says email is **unverified** | Student only                                                                                                             |
| **Existing** account later added to a list       | **Nothing changes automatically.** Grant it: `npm run roles -w backend -- grant --email … --role MANAGER`                |
| Email **removed** from a list                    | **Nothing changes automatically.** Revoke it: `npm run roles -w backend -- revoke --email … --role MANAGER --reason "…"` |

The list is a **ceiling**: the `grant` command refuses Manager/POS for emails not on the matching
list.

## First administrator

There's no public admin sign-up, and allowlists never grant Admin. To create the first
administrator:

1. The person signs in to CampusCart once, so their account exists. Their email must be verified
   by Google.
2. Someone with access to the server and database runs:
   ```bash
   npm run admin:grant -w backend -- --email person@example.com
   ```
3. The grant is written to the audit log with actor `CLI`. The new role works on their next
   request. They don't need to sign in again.

You can't revoke the last active administrator, so you can't lock yourself out.

## Revoking access

```bash
npm run roles -w backend -- revoke --email person@example.com --role POS --reason "Left the canteen team"
```

This marks the role as revoked (the history is kept), **signs the person out on every device**,
and writes an audit entry. Their live connections are closed within a minute, by the periodic
session re-check. Revoking from **Admin → Users & roles** does the same and closes live
connections immediately.
