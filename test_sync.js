const assert = require('assert').strict;

function normalizeUserSettings(input = {}) {
  return {
    redactSensitiveData: input.redactSensitiveData === undefined ? true : Boolean(input.redactSensitiveData),
  };
}

let userSettings = { redactSensitiveData: true }; // default

function applyUserSettings(nextSettings = {}) {
  userSettings = normalizeUserSettings({
    ...userSettings,
    ...nextSettings,
  });
  return userSettings;
}

// simulate dashboard fetch returning false
const dashboardSettings = { redactSensitiveData: false };

const result = applyUserSettings(dashboardSettings);
console.log(result);
