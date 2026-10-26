@echo off
rem Windows wrapper so the shell can start the mock server as an executable (dev.mjs).
node "%~dp0mock-server.mjs" %*
