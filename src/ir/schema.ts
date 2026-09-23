const nonEmptyString = {
  type: "string",
  minLength: 1,
} as const;

const nullableNonEmptyString = {
  anyOf: [
    nonEmptyString,
    {
      type: "null",
    },
  ],
} as const;

const timestamp = {
  type: "integer",
  minimum: 0,
} as const;

const sourceRefs = {
  type: "array",
  minItems: 1,
  items: {
    $ref: "#/$defs/sourceRef",
  },
} as const;

export const migrationBundleSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://trae2opencode.dev/schemas/migration-bundle.v1.schema.json",
  title: "Trae2OpenCode Migration Bundle v1",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "createdAt",
    "source",
    "projects",
    "sessions",
    "diagnostics",
  ],
  properties: {
    schemaVersion: {
      const: 1,
    },
    createdAt: {
      type: "string",
      format: "date-time",
    },
    source: {
      $ref: "#/$defs/sourceDescriptor",
    },
    projects: {
      type: "array",
      items: {
        $ref: "#/$defs/project",
      },
    },
    sessions: {
      type: "array",
      items: {
        $ref: "#/$defs/session",
      },
    },
    diagnostics: {
      type: "array",
      items: {
        $ref: "#/$defs/diagnostic",
      },
    },
  },
  $defs: {
    sha256: {
      type: "string",
      pattern: "^sha256:[a-f0-9]{64}$",
    },
    jsonValue: {
      anyOf: [
        {
          type: "null",
        },
        {
          type: "boolean",
        },
        {
          type: "number",
        },
        {
          type: "string",
        },
        {
          type: "array",
          items: {
            $ref: "#/$defs/jsonValue",
          },
        },
        {
          type: "object",
          additionalProperties: {
            $ref: "#/$defs/jsonValue",
          },
        },
      ],
    },
    parserProfile: {
      type: "object",
      additionalProperties: false,
      required: ["id", "version"],
      properties: {
        id: nonEmptyString,
        version: {
          type: "integer",
          minimum: 1,
        },
      },
    },
    sourceLocator: {
      type: "object",
      additionalProperties: false,
      required: ["type", "value"],
      properties: {
        type: {
          enum: [
            "runtime-field",
            "database-key",
            "relative-path",
            "workspace-state",
          ],
        },
        value: nonEmptyString,
      },
    },
    sourceRef: {
      type: "object",
      additionalProperties: false,
      required: [
        "workspaceStorageId",
        "sourceSessionId",
        "locator",
        "parserProfile",
        "sha256",
      ],
      properties: {
        workspaceStorageId: nullableNonEmptyString,
        sourceSessionId: nullableNonEmptyString,
        locator: {
          $ref: "#/$defs/sourceLocator",
        },
        parserProfile: {
          $ref: "#/$defs/parserProfile",
        },
        sha256: {
          $ref: "#/$defs/sha256",
        },
      },
    },
    sourceDescriptor: {
      type: "object",
      additionalProperties: false,
      required: [
        "product",
        "platform",
        "profile",
        "sourceFingerprint",
        "collectedAt",
      ],
      properties: {
        product: {
          type: "object",
          additionalProperties: false,
          required: ["name", "version"],
          properties: {
            name: {
              const: "trae-cn",
            },
            version: nonEmptyString,
          },
        },
        platform: {
          enum: ["darwin", "win32", "linux"],
        },
        profile: {
          type: "object",
          additionalProperties: false,
          required: ["id", "version", "verification"],
          properties: {
            id: nonEmptyString,
            version: {
              type: "integer",
              minimum: 1,
            },
            verification: {
              enum: ["verified", "unverified", "unsupported"],
            },
          },
        },
        sourceFingerprint: {
          $ref: "#/$defs/sha256",
        },
        collectedAt: {
          type: "string",
          format: "date-time",
        },
      },
    },
    project: {
      type: "object",
      additionalProperties: false,
      required: ["sourceId", "sourceRefs"],
      properties: {
        sourceId: nonEmptyString,
        name: nonEmptyString,
        path: nonEmptyString,
        sourceRefs,
      },
    },
    eventBase: {
      type: "object",
      required: ["sourceId", "order", "sourceRefs"],
      properties: {
        sourceId: nonEmptyString,
        order: {
          type: "integer",
          minimum: 0,
        },
        createdAt: timestamp,
        turnSourceId: nonEmptyString,
        replyToSourceId: nonEmptyString,
        sourceRefs,
      },
    },
    userEvent: {
      allOf: [
        {
          $ref: "#/$defs/eventBase",
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["sourceId", "order", "sourceRefs", "type", "text"],
          properties: {
            sourceId: true,
            order: true,
            createdAt: true,
            turnSourceId: true,
            replyToSourceId: true,
            sourceRefs: true,
            type: {
              const: "user",
            },
            text: {
              type: "string",
            },
          },
        },
      ],
    },
    contentBase: {
      type: "object",
      required: ["sourceRefs"],
      properties: {
        createdAt: timestamp,
        completedAt: timestamp,
        sourceRefs,
      },
    },
    textContent: {
      allOf: [
        {
          $ref: "#/$defs/contentBase",
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["type", "text", "sourceRefs"],
          properties: {
            type: {
              const: "text",
            },
            text: {
              type: "string",
            },
            createdAt: true,
            completedAt: true,
            sourceRefs: true,
          },
        },
      ],
    },
    reasoningContent: {
      allOf: [
        {
          $ref: "#/$defs/contentBase",
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["type", "text", "sourceRefs"],
          properties: {
            type: {
              const: "reasoning",
            },
            text: {
              type: "string",
            },
            createdAt: true,
            completedAt: true,
            sourceRefs: true,
          },
        },
      ],
    },
    toolContent: {
      allOf: [
        {
          $ref: "#/$defs/contentBase",
        },
        {
          type: "object",
          additionalProperties: false,
          required: [
            "type",
            "callId",
            "name",
            "input",
            "status",
            "sourceRefs",
          ],
          properties: {
            type: {
              const: "tool",
            },
            callId: nonEmptyString,
            name: nonEmptyString,
            input: {
              $ref: "#/$defs/jsonValue",
            },
            output: {
              $ref: "#/$defs/jsonValue",
            },
            error: {
              $ref: "#/$defs/jsonValue",
            },
            status: {
              enum: [
                "running",
                "streaming",
                "completed",
                "error",
                "unknown",
              ],
            },
            createdAt: true,
            completedAt: true,
            sourceRefs: true,
          },
        },
      ],
    },
    assistantContent: {
      oneOf: [
        {
          $ref: "#/$defs/textContent",
        },
        {
          $ref: "#/$defs/reasoningContent",
        },
        {
          $ref: "#/$defs/toolContent",
        },
      ],
    },
    assistantEvent: {
      allOf: [
        {
          $ref: "#/$defs/eventBase",
        },
        {
          type: "object",
          additionalProperties: false,
          required: [
            "sourceId",
            "order",
            "sourceRefs",
            "type",
            "status",
            "content",
          ],
          properties: {
            sourceId: true,
            order: true,
            createdAt: true,
            turnSourceId: true,
            replyToSourceId: true,
            sourceRefs: true,
            type: {
              const: "assistant",
            },
            status: {
              enum: ["completed", "running", "error", "unknown"],
            },
            completedAt: timestamp,
            content: {
              type: "array",
              items: {
                $ref: "#/$defs/assistantContent",
              },
            },
          },
        },
      ],
    },
    event: {
      oneOf: [
        {
          $ref: "#/$defs/userEvent",
        },
        {
          $ref: "#/$defs/assistantEvent",
        },
      ],
    },
    resource: {
      type: "object",
      additionalProperties: false,
      required: ["sourceId", "type", "availability", "sourceRefs"],
      properties: {
        sourceId: nonEmptyString,
        type: {
          enum: ["attachment", "file", "image", "long-text", "unknown"],
        },
        availability: {
          enum: ["available", "missing", "deferred"],
        },
        relativePath: nonEmptyString,
        mimeType: nonEmptyString,
        sha256: {
          $ref: "#/$defs/sha256",
        },
        sizeBytes: {
          type: "integer",
          minimum: 0,
        },
        sourceRefs,
      },
    },
    session: {
      type: "object",
      additionalProperties: false,
      required: [
        "sourceId",
        "recovery",
        "events",
        "resources",
        "sourceRefs",
      ],
      properties: {
        sourceId: nonEmptyString,
        title: nonEmptyString,
        projectSourceId: nonEmptyString,
        projectPath: nonEmptyString,
        parentSourceId: nonEmptyString,
        createdAt: timestamp,
        updatedAt: timestamp,
        recovery: {
          enum: [
            "complete",
            "partial",
            "metadata-only",
            "unrecoverable",
          ],
        },
        events: {
          type: "array",
          items: {
            $ref: "#/$defs/event",
          },
        },
        resources: {
          type: "array",
          items: {
            $ref: "#/$defs/resource",
          },
        },
        sourceRefs,
      },
    },
    diagnosticSubject: {
      type: "object",
      additionalProperties: false,
      required: ["type"],
      properties: {
        type: {
          enum: ["bundle", "project", "session", "event", "resource"],
        },
        sourceId: nonEmptyString,
      },
    },
    diagnostic: {
      type: "object",
      additionalProperties: false,
      required: ["id", "severity", "code", "message", "sourceRefs"],
      properties: {
        id: nonEmptyString,
        severity: {
          enum: ["info", "warning", "error"],
        },
        code: {
          type: "string",
          pattern: "^[A-Z][A-Z0-9_]*$",
        },
        message: nonEmptyString,
        subject: {
          $ref: "#/$defs/diagnosticSubject",
        },
        sourceRefs: {
          type: "array",
          items: {
            $ref: "#/$defs/sourceRef",
          },
        },
        context: {
          type: "object",
          additionalProperties: {
            $ref: "#/$defs/jsonValue",
          },
        },
      },
    },
  },
} as const;
