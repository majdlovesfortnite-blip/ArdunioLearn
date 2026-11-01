# ArduinoPath

A learning app for Arduino with accounts and saved progress.

## Setup

    npm install
    # Install arduino-cli from arduino.cc, then:
    arduino-cli core install arduino:avr
    npm start

Open http://localhost:3000.

Replace the `REPLACE_WITH_WOKWI_PROJECT_ID` values in `server.js` with real Wokwi project IDs.
Compilation runs untrusted code on the server; sandbox it (e.g. Docker, no network) before going live.
