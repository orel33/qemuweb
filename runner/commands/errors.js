'use strict';

// An error whose HTTP status the runner chose (sent as error.status in the response).
function statusError(message, status) {
  return Object.assign(new Error(message), {status});
}

module.exports = {statusError};
