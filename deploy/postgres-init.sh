#!/bin/sh
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=app_password="$APP_DB_PASSWORD" <<'SQL'
CREATE USER group_agent WITH PASSWORD :'app_password';
CREATE DATABASE group_agent OWNER group_agent;
SQL
