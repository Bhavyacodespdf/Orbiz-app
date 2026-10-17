import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { CircleAlert, FlaskConical } from 'lucide-react';
import { Wordmark } from '@/components/ui/Wordmark';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { Panel } from '@/components/ui/Panel';
import { Spinner } from '@/components/feedback/Spinner';
import { ErrorState } from '@/components/feedback/ErrorState';
import { describeError } from '@/lib/errors';
import { describeAuthError } from '@/lib/auth-errors';
import { googleSignInUrl, useAuthProviders, useCurrentUser, useDevLogin } from '@/services/auth';

/** Only same-site paths are honoured (the backend enforces this too). */
function safePath(value: string | null): string {
  return value && /^\/(?![/\\])/.test(value) ? value : '/';
}

const devLoginSchema = z.object({
  email: z.email('Enter a valid email address'),
  displayName: z.string().trim().max(60).optional(),
});
type DevLoginValues = z.infer<typeof devLoginSchema>;

function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" className="size-5" aria-hidden>
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"
      />
    </svg>
  );
}

function DevLoginForm({ returnTo }: { returnTo: string }) {
  const navigate = useNavigate();
  const devLogin = useDevLogin();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<DevLoginValues>({ resolver: zodResolver(devLoginSchema) });

  return (
    <form
      noValidate
      onSubmit={handleSubmit((values) =>
        devLogin.mutate(
          { email: values.email, displayName: values.displayName || undefined },
          { onSuccess: () => navigate(returnTo, { replace: true }) },
        ),
      )}
      className="flex flex-col gap-3 rounded-(--radius-control) border border-dashed border-mustard-300 bg-mustard-50/60 p-4"
    >
      <div className="flex items-start gap-2 text-sm text-mustard-800">
        <FlaskConical className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p>
          <strong>Developer login — local testing only.</strong> Signs in as any email without
          Google. It is switched off in production and is not a test of real Google sign-in.
        </p>
      </div>
      <TextField
        label="Email"
        type="email"
        autoComplete="off"
        error={errors.email?.message}
        {...register('email')}
      />
      <TextField label="Display name (optional)" {...register('displayName')} />
      {devLogin.error && (
        <p role="alert" className="text-sm font-medium text-chili-600">
          {describeError(devLogin.error)}
        </p>
      )}
      <Button type="submit" variant="secondary" loading={devLogin.isPending}>
        Sign in as developer
      </Button>
    </form>
  );
}

export function LoginPage() {
  const [params] = useSearchParams();
  const returnTo = safePath(params.get('returnTo'));
  const errorMessage = describeAuthError(params.get('error'));
  const me = useCurrentUser();
  const providers = useAuthProviders();

  if (me.data) return <Navigate to={returnTo} replace />;

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="flex w-full max-w-md flex-col gap-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <Wordmark className="text-3xl" />
          <h1 className="text-3xl font-extrabold">Sign in to order</h1>
          <p className="text-espresso-500">Use any Google account — no college email required.</p>
        </div>

        <Panel className="flex flex-col gap-5 p-5 sm:p-6">
          {errorMessage && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-(--radius-control) border border-chili-100 bg-chili-50 p-3 text-sm text-chili-700"
            >
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <p>{errorMessage}</p>
            </div>
          )}

          {providers.isPending || me.isPending ? (
            <Spinner label="Loading sign-in options…" />
          ) : providers.error ? (
            <ErrorState
              error={providers.error}
              title="Sign-in is unavailable"
              onRetry={() => void providers.refetch()}
              retrying={providers.isFetching}
            />
          ) : (
            <>
              {providers.data.google ? (
                <a
                  href={googleSignInUrl(returnTo)}
                  className="inline-flex h-12 items-center justify-center gap-3 rounded-(--radius-control) border border-espresso-200 bg-white font-semibold text-espresso-900 shadow-press transition-colors hover:border-espresso-400"
                >
                  <GoogleMark />
                  Continue with Google
                </a>
              ) : (
                <div className="flex flex-col gap-2">
                  <Button size="lg" variant="secondary" disabled>
                    Continue with Google
                  </Button>
                  <p className="text-sm text-espresso-500">
                    Google sign-in isn’t configured on this server yet.
                  </p>
                </div>
              )}
              {providers.data.devLogin && <DevLoginForm returnTo={returnTo} />}
            </>
          )}
        </Panel>

        <p className="text-center text-xs text-espresso-500">
          We only use your Google name, email address and profile picture to run your account.
        </p>
      </div>
    </main>
  );
}
