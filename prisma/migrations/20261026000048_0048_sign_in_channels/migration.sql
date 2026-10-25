-- getproperty-api 0048 — sign-in on every channel (D-255, D-283; B7.8 sign-in): prospects sign in by phone outside
-- LINE (an SMS code to any phone, like a landlord signing up), so the OTP purpose `prospect_login` is added.
-- Google / Apple / LINE identities use core.user_identity (asset-core 0.5.0); no table changes.
-- Deviation (schema-design §7.5 row 122).

ALTER TYPE platform.otp_purpose ADD VALUE IF NOT EXISTS 'prospect_login';
