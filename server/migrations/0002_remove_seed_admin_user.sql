-- Remove the placeholder admin row seeded by 0000_initial.sql.
--
-- That INSERT was development seed data, but migrations are applied by hand against
-- both --local and --remote, so a verbatim run left an `admin` row in production.
--
-- It was not directly exploitable: logging in as it requires a Google account whose
-- `sub` claim equals 'test-uid-1', and `sub` is assigned by Google. The allowlist
-- lookup in UserService matches on both uid and email, so the row is unreachable
-- today. It is removed because a stray admin row becomes a live hazard the moment
-- that lookup is ever relaxed to email-only.
--
-- Seed data belongs in a dev-only migration, never in the initial schema.
DELETE FROM user_permissions
WHERE uid = 'test-uid-1'
  AND email = 'test@example.com';
