DROP TABLE IF EXISTS passkeys;
DELETE FROM auth_state WHERE purpose IN ('registration', 'authentication');
