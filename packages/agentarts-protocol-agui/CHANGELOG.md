# @huaweicloud/agentarts-protocol-agui

## 0.0.7

### Patch Changes

- a2a ag-ui
- Updated dependencies
  - @huaweicloud/agentarts-sdk@0.0.7

## 0.0.6

### Patch Changes

- a2a ag-ui
- Updated dependencies
  - @huaweicloud/agentarts-sdk@0.0.6

## 0.0.5

### Patch Changes

- a2a ag-ui
- Updated dependencies
  - @huaweicloud/agentarts-sdk@0.0.5

## 0.0.4

### Patch Changes

- a2a ag-ui
- Updated dependencies
  - @huaweicloud/agentarts-sdk@0.0.4

## 0.0.3

### Patch Changes

- a2a ag-ui
- Updated dependencies
  - @huaweicloud/agentarts-sdk@0.0.3

## 0.0.2

### Minor Changes

- 23b9b85: Add opt-in A2A 1.0 JSON-RPC and AG-UI 1.0 SSE text adapters with an execution coordinator independent of transport subscriptions, shared execution capacity, authenticated principal isolation, bounded replay, cancellation and explicit CORS policy. Publish the adapters together with the SDK extension API; cloud gateway compatibility has not yet been verified.

  Add full A2A JSON-RPC/REST/gRPC services with multi-turn tasks, structured/file parts, extension negotiation, signed/extended cards and allowlisted webhooks. Add the full AG-UI producer with tools, state, interrupt/resume, reasoning/activity/subagents and official event verification/reduction. Provide replaceable atomic ProtocolStorage and bounded, optionally encrypted local persistence with explicit checkpoint recovery; one OS process per directory, without distributed ownership or a durable webhook outbox.

  Update the workspace Huawei Cloud core compatibility dependency to CommonJS-compatible uuid >=11.1.1, addressing GHSA-w5hq-g745-h8pq.

  Include protocol acceptance gates in the default suite. Normalize AG-UI input and forward-compatible versions before application execution; preserve open application payloads. Separate A2A routing tenants from authenticated identities, return typed JSON-RPC errors, reject terminal subscriptions, validate ProtoJSON aliases, and add authenticated filtered task listing with signed seek cursors.

  Sanitize all authentication-provider exceptions, including typed protocol errors and identity accessor failures, without changing framework-owned abort/timeout/capacity behavior. Add both protocol packages to the npm verification and publishing workflow, with coordinated-version guards and immutable checkout references.

### Patch Changes

- A2A AG-UI协议支持
- Updated dependencies [23b9b85]
- Updated dependencies
  - @huaweicloud/agentarts-sdk@0.0.2
