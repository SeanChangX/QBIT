// ---------------------------------------------------------------------------
//  Passport Google OAuth setup
// ---------------------------------------------------------------------------
// Security fix: serializeUser stores only the user ID in the session.
// deserializeUser looks up the full user record from the SQLite users table.

import { PassportStatic } from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import * as userService from './services/user.service';
import logger from './logger';
import type { AppUser } from './types';

export type { AppUser };

export function setupAuth(passport: PassportStatic): void {
  // Store only the user ID in the session (not the full user object)
  passport.serializeUser((user, done) => {
    done(null, (user as AppUser).id);
  });

  // Reconstruct the full user from the database on each request
  passport.deserializeUser((id: string, done) => {
    const user = userService.getUserById(id);
    if (user) {
      done(null, user);
    } else {
      // User not found in DB -- session is stale
      done(null, false);
    }
  });

  const clientID = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientID || !clientSecret) {
    logger.warn('GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET not set -- Google OAuth disabled');
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

        // Persist / update the user in the database
        userService.upsertUser(user.id, {
          displayName: user.displayName,
          email: user.email,
          avatar: user.avatar,
        });

        done(null, user as unknown as Express.User);
      }
    )
  );
}
