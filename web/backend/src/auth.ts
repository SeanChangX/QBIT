import { PassportStatic } from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';

export interface AppUser {
  id: string;
  displayName: string;
  email: string;
  avatar: string;
}

export function setupAuth(passport: PassportStatic): void {
  passport.serializeUser((user, done) => {
    done(null, user);
  });

  passport.deserializeUser((user: Express.User, done) => {
    done(null, user);
  });

  const clientID = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientID || !clientSecret) {
    console.warn(
      'GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET not set -- Google OAuth disabled'
    );
    return;
  }

  passport.use(
    new GoogleStrategy(
      {
        clientID,
        clientSecret,
        callbackURL:
          process.env.GOOGLE_CALLBACK_URL ||
          'https://qbit-api.labxcloud.com/auth/google/callback',
      },
      (_accessToken, _refreshToken, profile, done) => {
        const user: AppUser = {
          id: profile.id,
          displayName: profile.displayName,
          email: profile.emails?.[0]?.value || '',
          avatar: profile.photos?.[0]?.value || '',
        };
        done(null, user as any);
      }
    )
  );
}
