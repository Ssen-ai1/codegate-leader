// Public, non-secret release defaults. The commercial release pipeline replaces
// these placeholders before packaging; development may override them with env vars.
module.exports = Object.freeze({
  licenseServiceUrl: "",
  licensePublicKeyPem: "",
  updateFeedUrl: ""
});
