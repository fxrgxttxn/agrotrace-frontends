import type { OperationMeta } from './types.js';

export const OPERATIONS: readonly OperationMeta[] = [
  {
    "operationId": "login",
    "method": "POST",
    "path": "/auth/login",
    "roles": [
      "PUBLIC"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [
      "login-ip"
    ],
    "bearer": false,
    "signedAccess": false
  },
  {
    "operationId": "refreshToken",
    "method": "POST",
    "path": "/auth/refresh",
    "roles": [
      "PUBLIC"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": false,
    "signedAccess": false
  },
  {
    "operationId": "logout",
    "method": "POST",
    "path": "/auth/logout",
    "roles": [
      "PUBLIC"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": false,
    "signedAccess": false
  },
  {
    "operationId": "verifyTwoFactor",
    "method": "POST",
    "path": "/auth/2fa/verify",
    "roles": [
      "PUBLIC"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": false,
    "signedAccess": false
  },
  {
    "operationId": "setupTwoFactor",
    "method": "POST",
    "path": "/auth/2fa/setup",
    "roles": [
      "INSPECTOR",
      "ADMIN"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "forgotPassword",
    "method": "POST",
    "path": "/auth/password/forgot",
    "roles": [
      "PUBLIC"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [
      "forgot"
    ],
    "bearer": false,
    "signedAccess": false
  },
  {
    "operationId": "resetPassword",
    "method": "POST",
    "path": "/auth/password/reset",
    "roles": [
      "PUBLIC"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": false,
    "signedAccess": false
  },
  {
    "operationId": "registerOrganization",
    "method": "POST",
    "path": "/auth/register-organization",
    "roles": [
      "PUBLIC"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": false,
    "signedAccess": false
  },
  {
    "operationId": "acceptInvite",
    "method": "POST",
    "path": "/auth/accept-invite",
    "roles": [
      "PUBLIC"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": false,
    "signedAccess": false
  },
  {
    "operationId": "getMe",
    "method": "GET",
    "path": "/me",
    "roles": [
      "ANY"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "updateMe",
    "method": "PATCH",
    "path": "/me",
    "roles": [
      "ANY"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "uploadMyAvatar",
    "method": "PUT",
    "path": "/me/avatar",
    "roles": [
      "ANY"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "deleteMyAvatar",
    "method": "DELETE",
    "path": "/me/avatar",
    "roles": [
      "ANY"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "getMyChannels",
    "method": "GET",
    "path": "/me/channels",
    "roles": [
      "ANY"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "updateMyChannels",
    "method": "PUT",
    "path": "/me/channels",
    "roles": [
      "ANY"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "createTelegramCode",
    "method": "POST",
    "path": "/me/telegram-code",
    "roles": [
      "ANY"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "listUsers",
    "method": "GET",
    "path": "/users",
    "roles": [
      "FARMER",
      "PROCESSOR",
      "LAB",
      "RETAILER",
      "INSPECTOR",
      "ADMIN"
    ],
    "orgAdmin": true,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false,
    "sort": {
      "fields": [
        "fullName",
        "email",
        "createdAt"
      ],
      "default": "fullName,asc"
    }
  },
  {
    "operationId": "inviteUser",
    "method": "POST",
    "path": "/users",
    "roles": [
      "FARMER",
      "PROCESSOR",
      "LAB",
      "RETAILER",
      "INSPECTOR",
      "ADMIN"
    ],
    "orgAdmin": true,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "updateUser",
    "method": "PATCH",
    "path": "/users/{id}",
    "roles": [
      "FARMER",
      "PROCESSOR",
      "LAB",
      "RETAILER",
      "INSPECTOR",
      "ADMIN"
    ],
    "orgAdmin": true,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "getUserAvatar",
    "method": "GET",
    "path": "/users/{id}/avatar",
    "roles": [
      "ANY"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "listOrganizations",
    "method": "GET",
    "path": "/organizations",
    "roles": [
      "ANY"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false,
    "sort": {
      "fields": [
        "name"
      ],
      "default": "name,asc"
    }
  },
  {
    "operationId": "getOrganization",
    "method": "GET",
    "path": "/organizations/{id}",
    "roles": [
      "ANY"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "getOrganizationLogo",
    "method": "GET",
    "path": "/organizations/{id}/logo",
    "roles": [
      "ANY"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "uploadOrganizationLogo",
    "method": "PUT",
    "path": "/organizations/{id}/logo",
    "roles": [
      "FARMER",
      "PROCESSOR",
      "LAB",
      "RETAILER",
      "INSPECTOR",
      "ADMIN"
    ],
    "orgAdmin": true,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "listFields",
    "method": "GET",
    "path": "/fields",
    "roles": [
      "FARMER",
      "INSPECTOR",
      "ADMIN"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false,
    "sort": {
      "fields": [
        "name",
        "areaHa",
        "lastTreatmentAt",
        "createdAt"
      ],
      "default": "name,asc"
    }
  },
  {
    "operationId": "createField",
    "method": "POST",
    "path": "/fields",
    "roles": [
      "FARMER"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "getField",
    "method": "GET",
    "path": "/fields/{id}",
    "roles": [
      "FARMER",
      "INSPECTOR",
      "ADMIN"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "updateField",
    "method": "PUT",
    "path": "/fields/{id}",
    "roles": [
      "FARMER"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "deleteField",
    "method": "DELETE",
    "path": "/fields/{id}",
    "roles": [
      "FARMER"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "listFieldTreatments",
    "method": "GET",
    "path": "/fields/{id}/treatments",
    "roles": [
      "FARMER",
      "INSPECTOR",
      "ADMIN"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false,
    "sort": {
      "fields": [
        "appliedAt",
        "createdAt"
      ],
      "default": "appliedAt,desc"
    }
  },
  {
    "operationId": "createTreatment",
    "method": "POST",
    "path": "/fields/{id}/treatments",
    "roles": [
      "FARMER"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "updateTreatment",
    "method": "PUT",
    "path": "/treatments/{id}",
    "roles": [
      "FARMER"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "listBatches",
    "method": "GET",
    "path": "/batches",
    "roles": [
      "ANY"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false,
    "sort": {
      "fields": [
        "publicCode",
        "massKg",
        "updatedAt",
        "harvestedAt",
        "producedAt"
      ],
      "default": "updatedAt,desc"
    }
  },
  {
    "operationId": "createBatch",
    "method": "POST",
    "path": "/batches",
    "roles": [
      "FARMER"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "getBatch",
    "method": "GET",
    "path": "/batches/{id}",
    "roles": [
      "ANY"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "getBatchGraph",
    "method": "GET",
    "path": "/batches/{id}/graph",
    "roles": [
      "ANY"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "getBatchHistory",
    "method": "GET",
    "path": "/batches/{id}/history",
    "roles": [
      "ANY"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "getBatchPath",
    "method": "GET",
    "path": "/batches/{id}/path",
    "roles": [
      "ANY"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "downloadBatchQr",
    "method": "GET",
    "path": "/batches/{id}/qr",
    "roles": [
      "PROCESSOR",
      "RETAILER"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "createBatchQr",
    "method": "POST",
    "path": "/batches/{id}/qr",
    "roles": [
      "PROCESSOR",
      "RETAILER"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "getBatchDocuments",
    "method": "GET",
    "path": "/batches/{id}/documents",
    "roles": [
      "ANY"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "retryBatchVsdImport",
    "method": "POST",
    "path": "/batches/{id}/documents/vsd/retry",
    "roles": [
      "FARMER",
      "PROCESSOR"
    ],
    "orgAdmin": false,
    "idempotent": true,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "putBatchOnSale",
    "method": "POST",
    "path": "/batches/{id}/on-sale",
    "roles": [
      "RETAILER"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "markBatchSold",
    "method": "POST",
    "path": "/batches/{id}/sold",
    "roles": [
      "RETAILER"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "processBatches",
    "method": "POST",
    "path": "/processing",
    "roles": [
      "PROCESSOR"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "listWaybills",
    "method": "GET",
    "path": "/waybills",
    "roles": [
      "FARMER",
      "PROCESSOR",
      "RETAILER",
      "INSPECTOR",
      "ADMIN"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false,
    "sort": {
      "fields": [
        "createdAt",
        "sentAt",
        "acceptedAt",
        "number"
      ],
      "default": "createdAt,desc"
    }
  },
  {
    "operationId": "createWaybill",
    "method": "POST",
    "path": "/waybills",
    "roles": [
      "FARMER",
      "PROCESSOR"
    ],
    "orgAdmin": false,
    "idempotent": true,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "getWaybill",
    "method": "GET",
    "path": "/waybills/{id}",
    "roles": [
      "FARMER",
      "PROCESSOR",
      "RETAILER",
      "INSPECTOR",
      "ADMIN"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "deleteWaybill",
    "method": "DELETE",
    "path": "/waybills/{id}",
    "roles": [
      "FARMER",
      "PROCESSOR"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "sendWaybill",
    "method": "POST",
    "path": "/waybills/{id}/send",
    "roles": [
      "FARMER",
      "PROCESSOR"
    ],
    "orgAdmin": false,
    "idempotent": true,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "acceptWaybill",
    "method": "POST",
    "path": "/waybills/{id}/accept",
    "roles": [
      "PROCESSOR",
      "RETAILER"
    ],
    "orgAdmin": false,
    "idempotent": true,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "rejectWaybill",
    "method": "POST",
    "path": "/waybills/{id}/reject",
    "roles": [
      "PROCESSOR",
      "RETAILER"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "downloadFile",
    "method": "GET",
    "path": "/files/{id}",
    "roles": [
      "ANY"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": true
  },
  {
    "operationId": "getPublicBatch",
    "method": "GET",
    "path": "/public/batches/{publicCode}",
    "roles": [
      "PUBLIC"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": false,
    "signedAccess": false
  },
  {
    "operationId": "createPublicComplaint",
    "method": "POST",
    "path": "/public/batches/{publicCode}/complaints",
    "roles": [
      "PUBLIC"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [
      "complaint-ip"
    ],
    "bearer": false,
    "signedAccess": false
  },
  {
    "operationId": "getCaptchaChallenge",
    "method": "GET",
    "path": "/public/captcha",
    "roles": [
      "PUBLIC"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": false,
    "signedAccess": false
  },
  {
    "operationId": "downloadPublicFile",
    "method": "GET",
    "path": "/public/files/{id}",
    "roles": [
      "PUBLIC"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": false,
    "signedAccess": false
  },
  {
    "operationId": "listPublicRegions",
    "method": "GET",
    "path": "/public/regions",
    "roles": [
      "PUBLIC"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": false,
    "signedAccess": false
  },
  {
    "operationId": "listLabTests",
    "method": "GET",
    "path": "/lab-tests",
    "roles": [
      "ANY"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false,
    "sort": {
      "fields": [
        "dueAt",
        "createdAt",
        "completedAt"
      ],
      "default": "dueAt,asc"
    }
  },
  {
    "operationId": "createLabTest",
    "method": "POST",
    "path": "/lab-tests",
    "roles": [
      "INSPECTOR"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "getLabTest",
    "method": "GET",
    "path": "/lab-tests/{id}",
    "roles": [
      "ANY"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "registerLabSample",
    "method": "POST",
    "path": "/lab-tests/{id}/sample",
    "roles": [
      "LAB"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "submitLabResults",
    "method": "POST",
    "path": "/lab-tests/{id}/results",
    "roles": [
      "LAB"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "downloadLabProtocol",
    "method": "GET",
    "path": "/lab-tests/{id}/protocol",
    "roles": [
      "ANY"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "uploadLabProtocol",
    "method": "PUT",
    "path": "/lab-tests/{id}/protocol",
    "roles": [
      "LAB"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "listRecalls",
    "method": "GET",
    "path": "/recalls",
    "roles": [
      "INSPECTOR",
      "ADMIN"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false,
    "sort": {
      "fields": [
        "openedAt",
        "closedAt"
      ],
      "default": "openedAt,desc"
    }
  },
  {
    "operationId": "createRecall",
    "method": "POST",
    "path": "/recalls",
    "roles": [
      "INSPECTOR"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "getRecall",
    "method": "GET",
    "path": "/recalls/{id}",
    "roles": [
      "INSPECTOR",
      "ADMIN"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "getRecallGraph",
    "method": "GET",
    "path": "/recalls/{id}/graph",
    "roles": [
      "INSPECTOR",
      "ADMIN"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "listRecallTasks",
    "method": "GET",
    "path": "/recall-tasks",
    "roles": [
      "FARMER",
      "PROCESSOR",
      "RETAILER",
      "INSPECTOR"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false,
    "sort": {
      "fields": [
        "dueAt",
        "createdAt",
        "confirmedAt"
      ],
      "default": "dueAt,asc"
    }
  },
  {
    "operationId": "confirmRecallTask",
    "method": "POST",
    "path": "/recall-tasks/{id}/confirm",
    "roles": [
      "FARMER",
      "PROCESSOR",
      "RETAILER"
    ],
    "orgAdmin": false,
    "idempotent": true,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "listComplaints",
    "method": "GET",
    "path": "/complaints",
    "roles": [
      "INSPECTOR"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false,
    "sort": {
      "fields": [
        "createdAt",
        "decidedAt"
      ],
      "default": "createdAt,desc"
    }
  },
  {
    "operationId": "getComplaint",
    "method": "GET",
    "path": "/complaints/{id}",
    "roles": [
      "INSPECTOR"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "startComplaintReview",
    "method": "POST",
    "path": "/complaints/{id}/review",
    "roles": [
      "INSPECTOR"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "decideComplaint",
    "method": "POST",
    "path": "/complaints/{id}/decision",
    "roles": [
      "INSPECTOR"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "listNotifications",
    "method": "GET",
    "path": "/notifications",
    "roles": [
      "ANY"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false,
    "sort": {
      "fields": [
        "seq"
      ],
      "default": "seq,desc"
    }
  },
  {
    "operationId": "markNotificationsRead",
    "method": "POST",
    "path": "/notifications/read",
    "roles": [
      "ANY"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "getDashboard",
    "method": "GET",
    "path": "/analytics/dashboard",
    "roles": [
      "ANY"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "downloadReport",
    "method": "GET",
    "path": "/reports/{type}",
    "roles": [
      "FARMER",
      "PROCESSOR",
      "LAB",
      "RETAILER",
      "INSPECTOR",
      "ADMIN"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false,
    "reportAccess": {
      "batches": {
        "roles": [
          "INSPECTOR",
          "ADMIN"
        ],
        "headRoles": [
          "FARMER",
          "PROCESSOR",
          "RETAILER"
        ]
      },
      "recalls": {
        "roles": [
          "INSPECTOR",
          "ADMIN"
        ],
        "headRoles": []
      },
      "recall": {
        "roles": [
          "INSPECTOR",
          "ADMIN"
        ],
        "headRoles": []
      },
      "lab-tests": {
        "roles": [
          "INSPECTOR",
          "ADMIN"
        ],
        "headRoles": [
          "LAB"
        ]
      },
      "complaints": {
        "roles": [
          "INSPECTOR",
          "ADMIN"
        ],
        "headRoles": []
      },
      "org": {
        "roles": [
          "INSPECTOR",
          "ADMIN"
        ],
        "headRoles": [
          "FARMER",
          "PROCESSOR",
          "LAB",
          "RETAILER"
        ]
      }
    }
  },
  {
    "operationId": "listAdminOrganizations",
    "method": "GET",
    "path": "/admin/organizations",
    "roles": [
      "ADMIN"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false,
    "sort": {
      "fields": [
        "createdAt",
        "name"
      ],
      "default": "createdAt,desc"
    }
  },
  {
    "operationId": "updateAdminOrganization",
    "method": "PATCH",
    "path": "/admin/organizations/{id}",
    "roles": [
      "ADMIN"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "approveOrganization",
    "method": "POST",
    "path": "/admin/organizations/{id}/approve",
    "roles": [
      "ADMIN"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "listDictionary",
    "method": "GET",
    "path": "/dictionaries/{name}",
    "roles": [
      "ANY"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false,
    "sort": {
      "fields": [
        "name"
      ],
      "default": "name,asc"
    }
  },
  {
    "operationId": "createDictionaryEntry",
    "method": "POST",
    "path": "/dictionaries/{name}",
    "roles": [
      "ADMIN"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "updateDictionaryEntry",
    "method": "PUT",
    "path": "/dictionaries/{name}/{id}",
    "roles": [
      "ADMIN"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "deleteDictionaryEntry",
    "method": "DELETE",
    "path": "/dictionaries/{name}/{id}",
    "roles": [
      "ADMIN"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "importDictionary",
    "method": "POST",
    "path": "/dictionaries/{name}/import",
    "roles": [
      "ADMIN"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "uploadProductImage",
    "method": "PUT",
    "path": "/dictionaries/products/{id}/image",
    "roles": [
      "ADMIN"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false
  },
  {
    "operationId": "listAuditLog",
    "method": "GET",
    "path": "/audit-log",
    "roles": [
      "INSPECTOR",
      "ADMIN"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": true,
    "signedAccess": false,
    "sort": {
      "fields": [
        "createdAt"
      ],
      "default": "createdAt,desc"
    }
  },
  {
    "operationId": "getHealthLive",
    "method": "GET",
    "path": "/health/live",
    "roles": [
      "PUBLIC"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": false,
    "signedAccess": false
  },
  {
    "operationId": "getHealthReady",
    "method": "GET",
    "path": "/health/ready",
    "roles": [
      "PUBLIC"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": false,
    "signedAccess": false
  },
  {
    "operationId": "streamEvents",
    "method": "GET",
    "path": "/events/stream",
    "roles": [
      "ANY"
    ],
    "orgAdmin": false,
    "idempotent": false,
    "rateLimit": [],
    "bearer": false,
    "signedAccess": false
  }
];
