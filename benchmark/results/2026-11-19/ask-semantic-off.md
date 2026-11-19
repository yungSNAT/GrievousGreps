# gg-bench ask on semble's 1,251 questions at `ebef20c`, `TRAIL_SEMANTIC=0`

The tool built at `ebef20c` (branch `ryan/semantic-ask-2026-11-19`) was asked every question on the benchmark machine (Linux) from 18:15 to 18:30 UTC on 19 November 2026 with `TRAIL_SEMANTIC=0`, so it ranked by words only. `gg-bench ask` from #125's branch at `658ba18` graded it, whose code differs from `8b3b71f` (#125 merged) only by moving its unit tests to `ask/tests.rs` ([cmd-ask-semantic.sh](cmd-ask-semantic.sh), run with `MODE=off`). Later commits on the branch change code only for `ask --in`, which `gg-bench ask` does not pass. Local paths are replaced by `<path>`. [ask-semantic-off-files.json](ask-semantic-off-files.json) holds the files each answer ranked, the first 10 distinct per question. [ask-semantic-on.md](ask-semantic-on.md) is the same commit with semantic ranking on.

```text
Node v26.13.1, 2026-11-19 UTC
Tool: <path>/dist/bin/graft.js (0.28.0+gg.ebef20c6a787)
Set: benchmark/ask/semble, 1251 questions in 63 repositories; 0 failed
```


| Set | Queries | NDCG@10 | hit@1 | hit@3 | hit@10 |
| --- | --- | --- | --- | --- | --- |
| All | 1251 | 0.750 | 0.543 | 0.792 | 0.931 |
| architecture | 344 | 0.694 | 0.451 | 0.733 | 0.910 |
| semantic | 703 | 0.748 | 0.543 | 0.791 | 0.926 |
| symbol | 204 | 0.851 | 0.696 | 0.897 | 0.985 |
| bash | 60 | 0.867 | 0.833 | 0.900 | 0.933 |
| c | 60 | 0.665 | 0.417 | 0.700 | 0.867 |
| cpp | 60 | 0.732 | 0.483 | 0.833 | 0.950 |
| csharp | 60 | 0.784 | 0.600 | 0.833 | 0.950 |
| elixir | 58 | 0.814 | 0.603 | 0.879 | 0.983 |
| go | 58 | 0.752 | 0.569 | 0.707 | 0.931 |
| haskell | 60 | 0.697 | 0.417 | 0.783 | 0.933 |
| java | 61 | 0.720 | 0.492 | 0.754 | 0.885 |
| javascript | 60 | 0.878 | 0.750 | 0.900 | 0.967 |
| kotlin | 60 | 0.660 | 0.333 | 0.733 | 0.933 |
| lua | 60 | 0.779 | 0.550 | 0.850 | 0.983 |
| php | 60 | 0.751 | 0.650 | 0.767 | 0.883 |
| python | 184 | 0.781 | 0.549 | 0.826 | 0.946 |
| ruby | 58 | 0.755 | 0.534 | 0.810 | 0.931 |
| rust | 60 | 0.616 | 0.450 | 0.617 | 0.800 |
| scala | 59 | 0.744 | 0.559 | 0.763 | 0.932 |
| swift | 53 | 0.755 | 0.528 | 0.774 | 0.962 |
| typescript | 60 | 0.670 | 0.433 | 0.700 | 0.933 |
| zig | 60 | 0.769 | 0.550 | 0.850 | 0.967 |

Misses at 3 (no relevant file among the first 3):

| Repository | Category | Query | First relevant | Relevant | First 3 returned |
| --- | --- | --- | --- | --- | --- |
| aiohttp | semantic | request and response object internals | 8 | aiohttp/client_reqrep.py | web_response.py, client.py, web_protocol.py |
| aiohttp | semantic | response streaming and payload | none | aiohttp/streams.py | payload.py, web_response.py, multipart.py |
| aiohttp | semantic | HTTP exception types and error responses | 9 | aiohttp/web_exceptions.py | http_exceptions.py, helpers.py, web_urldispatcher.py |
| aiohttp | architecture | how chunked transfer encoding is parsed | 5 | aiohttp/http_parser.py | client_reqrep.py, http_exceptions.py, web_response.py |
| aiohttp | architecture | how DNS resolution is handled asynchronously | 10 | aiohttp/resolver.py | tracing.py, connector.py, client_exceptions.py |
| aiohttp | architecture | how backpressure and flow control work in streaming | none | aiohttp/streams.py | _websocket/writer.py, hdrs.py, payload.py |
| fastapi | semantic | websocket endpoint implementation | none | fastapi/websockets.py | applications.py, routing.py, exceptions.py |
| fastapi | semantic | OpenAPI schema generation | none | fastapi/openapi/utils.py | openapi/models.py, routing.py, security/open_id_connect_url.py |
| fastapi | semantic | response model serialization | none | fastapi/encoders.py | utils.py, routing.py, openapi/models.py |
| fastapi | semantic | running work after returning an HTTP response without blocking | 8 | fastapi/background.py | concurrency.py, routing.py, sse.py |
| fastapi | architecture | how are path parameters extracted and type-converted | none | fastapi/routing.py | openapi/utils.py, __init__, __main__ |
| fastapi | architecture | how does exception propagation work through dependency injection | 4 | fastapi/dependencies/utils.py | exception_handlers.py, exceptions.py, applications.py |
| flask | architecture | how are routes registered | 7 | src/flask/sansio/scaffold.py | cli.py, sansio/app.py, sansio/blueprints.py |
| flask | semantic | g | none | src/flask/globals.py |  |
| httpx | semantic | connection pooling and transport | 5 | httpx/_transports/default.py | _client.py, _exceptions.py, _transports/base.py |
| httpx | semantic | URL parsing and construction | 7 | httpx/_urlparse.py | _urls.py, _client.py, _exceptions.py |
| httpx | architecture | how does streaming response body iteration work | 4 | httpx/_models.py | _exceptions.py, _auth.py, _transports/asgi.py |
| httpx | architecture | how the HTTP transport backend sends requests over the wire | 10 | httpx/_transports/default.py | _transports/base.py, _transports/mock.py, _exceptions.py |
| model2vec | semantic | saving and loading models from disk | 5 | model2vec/persistence/persistence.py | model.py, distill/distillation.py, train/base.py |
| model2vec | semantic | reducing embedding precision to smaller integer representations | none | model2vec/quantization.py | model.py, persistence/persistence.py, train/base.py |
| model2vec | semantic | generating model cards for publication | 7 | model2vec/modelcards/modelcards.py | model.py, distill/inference.py, inference/model.py |
| model2vec | architecture | how out-of-vocabulary tokens are handled at inference time | 4 | model2vec/model.py | tokenizer/tokenizer.py, distill/inference.py, vocabulary_quantization.py |
| pydantic | architecture | how are model fields declared and constrained | none | pydantic/fields.py | _internal/_fields.py, v1/types.py, v1/schema.py |
| pydantic | architecture | how to serialize models to JSON | 6 | pydantic/functional_serializers.py | v1/schema.py, json_schema.py, types.py |
| pydantic | semantic | model configuration and settings | none | pydantic/config.py | v1/env_settings.py, env_settings.py, mypy.py |
| pydantic | semantic | alias handling for field names | 9 | pydantic/aliases.py | _internal/_fields.py, v1/env_settings.py, mypy.py |
| pydantic | architecture | how to validate a function's arguments with pydantic | 4 | pydantic/validate_call_decorator.py | deprecated/decorator.py, v1/decorator.py, experimental/arguments_schema.py |
| pydantic | symbol | Field | 8 | pydantic/fields.py | _internal/_generate_schema.py, _internal/_fields.py, v1/schema.py |
| requests | semantic | request and response model internals | 5 | src/requests/models.py | api.py, exceptions.py, sessions.py |
| starlette | semantic | websocket connection and message handling | 6 | starlette/websockets.py | _exception_handler.py, responses.py, routing.py |
| starlette | semantic | parsing form data and file uploads | 5 | starlette/formparsers.py | datastructures.py, requests.py, __init__ |
| starlette | symbol | Request | 4 | starlette/requests.py | middleware/base.py, testclient.py, routing.py |
| axios | architecture | how HTTP requests are dispatched through the configured adapter | 4 | lib/core/dispatchRequest.js | adapters/adapters.js, adapters/http.js, helpers/HttpStatusCode.js |
| axios | semantic | request and response interceptors | none | lib/core/InterceptorManager.js | core/dispatchRequest.js, core/Axios.js, adapters/http.js |
| axios | semantic | HTTP response settling and status code validation | 5 | lib/core/settle.js | helpers/HttpStatusCode.js, adapters/http.js, axios.js |
| axios | architecture | axios default configuration and request/response transformers | none | lib/defaults/index.js | core/dispatchRequest.js, core/AxiosError.js, core/Axios.js |
| axios | architecture | how axios instances are created with custom base config | 5 | lib/core/Axios.js | core/AxiosError.js, helpers/resolveConfig.js, core/mergeConfig.js |
| redux | semantic | function composition utility | 8 | src/compose.ts | types/middleware.ts, types/store.ts, applyMiddleware.ts |
| gin | architecture | how routes are grouped and registered | 4 | routergroup.go | ginS/gins.go, gin.go, debug.go |
| gin | architecture | how the Gin Engine embeds RouterGroup and uses Context per request | 4 | gin.go | routergroup.go, ginS/gins.go, test_helpers.go |
| gin | semantic | multipart form and file upload handling | 5 | context.go | binding/multipart_form_mapping.go, doc, version |
| gin | semantic | error types and per-request error collection | 6 | errors.go | context.go, recovery.go, binding/multipart_form_mapping.go |
| gin | architecture | how validators are plugged in for struct binding | none | binding/default_validator.go | binding/binding.go, binding/binding_nomsgpack.go, binding/bson.go |
| gin | architecture | how middleware is applied globally and to route groups | 5 | routergroup.go | gin.go, ginS/gins.go, debug.go |
| gin | semantic | utility helpers for path detection and content-type formatting | none | utils.go | render/render.go, test_helpers.go, render/pdf.go |
| gin | symbol | Engine | 4 | gin.go | binding/default_validator.go, binding/binding_nomsgpack.go, binding/binding.go |
| cobra | architecture | core command execution and command tree | 4 | command.go | doc/man_docs.go, doc/md_docs.go, doc/yaml_docs.go |
| chi | architecture | HTTP router and middleware composition | none | mux.go | _examples/rest/main.go, chain.go, _examples/versions/main.go |
| chi | semantic | request logging middleware | 4 | middleware/logger.go | middleware/request_size.go, _examples/rest/main.go, middleware/request_id.go |
| chi | semantic | panic recovery middleware | 4 | middleware/recoverer.go | middleware/logger.go, _examples/versions/main.go, middleware/middleware.go |
| chi | semantic | request throttling and concurrency limiting | 5 | middleware/throttle.go | middleware/request_id.go, _examples/rest/main.go, middleware/logger.go |
| chi | semantic | URL path stripping and rewriting middleware | 9 | middleware/strip.go | middleware/url_format.go, middleware/path_rewrite.go, middleware/clean_path.go |
| chi | architecture | how URL parameters are extracted from path segments at request time | 5 | context.go | middleware/url_format.go, middleware/clean_path.go, middleware/path_rewrite.go |
| chi | symbol | Router | 6 | mux.go | _examples/rest/main.go, chi.go, _examples/versions/main.go |
| chi | architecture | how chi resolves named URL parameters and wildcards during routing | none | tree.go | middleware/url_format.go, context.go, chi.go |
| gson | architecture | how null values are handled during serialization | none | gson/src/main/java/com/google/gson/Gson.java | src/main/java/com/google/gson/JsonSerializationContext.java, src/main/java/com/google/gson/LongSerializationPolicy.java, src/main/java/com/google/gson/internal/bind/TypeAdapters.java |
| gson | semantic | JSON element hierarchy and tree model | 4 | gson/src/main/java/com/google/gson/JsonElement.java | src/main/java/com/google/gson/internal/bind/JsonTreeReader.java, src/main/java/com/google/gson/internal/bind/JsonTreeWriter.java, src/main/java/com/google/gson/internal/bind/TreeTypeAdapter.java |
| gson | architecture | how type adapter factories are registered and selected for a given type | none | gson/src/main/java/com/google/gson/Gson.java | src/main/java/com/google/gson/GsonBuilder.java, src/main/java/com/google/gson/TypeAdapterFactory.java, src/main/java/com/google/gson/internal/bind/TypeAdapterRuntimeTypeWrapper.java |
| commons-lang | semantic | null-safe string operations and text helpers | 7 | src/main/java/org/apache/commons/lang3/StringUtils.java | concurrent/AtomicSafeInitializer.java, text/StrBuilder.java, builder/ToStringStyle.java |
| commons-lang | semantic | argument validation helpers and exception rules | none | src/main/java/org/apache/commons/lang3/Validate.java | SystemProperties.java, time/FastDatePrinter.java, exception/DefaultExceptionContext.java |
| commons-lang | semantic | array utility operations and safe type conversion | 4 | src/main/java/org/apache/commons/lang3/ArrayUtils.java | Conversion.java, reflect/TypeUtils.java, concurrent/AtomicSafeInitializer.java |
| commons-lang | semantic | class utility methods for reflection and package navigation | 5 | src/main/java/org/apache/commons/lang3/ClassUtils.java | builder/ReflectionToStringBuilder.java, builder/HashCodeBuilder.java, reflect/MethodUtils.java |
| jackson-databind | semantic | mutable JSON object node with named field operations | 8 | src/main/java/tools/jackson/databind/node/ObjectNode.java | cfg/MutableConfigOverride.java, cfg/MutableCoercionConfig.java, deser/SettableAnyProperty.java |
| jackson-databind | architecture | polymorphic type resolution | none | src/main/java/tools/jackson/databind/jsontype/impl/StdTypeResolverBuilder.java | introspect/TypeResolutionContext.java, jsontype/PolymorphicTypeValidator.java, jsontype/BasicPolymorphicTypeValidator.java |
| jackson-databind | semantic | writing and serializing Java objects to JSON with configuration | none | src/main/java/tools/jackson/databind/ObjectWriter.java | util/NativeImageUtil.java, json/JsonMapper.java, cfg/JsonNodeFeature.java |
| jackson-databind | semantic | bean deserialization from JSON properties | 4 | src/main/java/tools/jackson/databind/deser/bean/BeanDeserializer.java | deser/bean/BeanDeserializerBase.java, deser/bean/BeanAsArrayDeserializer.java, deser/bean/BeanAsArrayBuilderDeserializer.java |
| jackson-databind | semantic | bean serialization of Java object fields to JSON | none | src/main/java/tools/jackson/databind/ser/BeanSerializer.java | jsonFormatVisitors/JsonObjectFormatVisitor.java, ser/BeanSerializerFactory.java, ser/bean/UnwrappingBeanSerializer.java |
| jackson-databind | semantic | type factory for parameterized and collection types | 4 | src/main/java/tools/jackson/databind/type/TypeFactory.java | type/CollectionType.java, type/CollectionLikeType.java, introspect/MethodGenericTypeResolver.java |
| jackson-databind | architecture | deserialization context and error accumulation during parsing | 5 | src/main/java/tools/jackson/databind/DeserializationContext.java | deser/impl/ErrorThrowingDeserializer.java, ObjectMapper.java, DeserializationConfig.java |
| jackson-databind | architecture | how the mapper resolves a deserializer for a given Java type | none | src/main/java/tools/jackson/databind/ObjectMapper.java | jsontype/impl/NoOpTypeDeserializer.java, jsontype/TypeDeserializer.java, deser/impl/TypeWrappedDeserializer.java |
| monolog | architecture | how log records propagate through the handler bubble chain | none | src/Monolog/Logger.php | Handler/LogEntriesHandler.php, Handler/AbstractProcessingHandler.php, Handler/ErrorLogHandler.php |
| monolog | architecture | how formatters transform log records into output strings | 5 | src/Monolog/Formatter/LineFormatter.php | Handler/BrowserConsoleHandler.php, LogRecord.php, Handler/SyslogUdpHandler.php |
| laravel-framework | architecture | queue connection resolution and connectors | none | src/Illuminate/Queue/QueueManager.php | Contracts/Container/BindingResolutionException.php, Queue/QueueServiceProvider.php, Database/Connectors/ConnectionFactory.php |
| laravel-framework | architecture | queue worker command execution | 7 | src/Illuminate/Queue/Console/WorkCommand.php | Queue/Worker.php, Queue/WorkerOptions.php, Queue/Events/WorkerStarting.php |
| laravel-framework | semantic | session store behavior | none | src/Illuminate/Session/Store.php | Session/SessionManager.php, Contracts/Session/Session.php, Session/Middleware/AuthenticateSession.php |
| laravel-framework | architecture | routing HTTP requests to controllers | none | src/Illuminate/Routing/Router.php | Foundation/Http/Middleware/HandlePrecognitiveRequests.php, Contracts/Auth/Middleware/AuthenticatesRequests.php, Foundation/Http/Middleware/PreventRequestsDuringMaintenance.php |
| laravel-framework | semantic | route parameter binding and model resolution | 5 | src/Illuminate/Routing/Route.php | Contracts/Container/BindingResolutionException.php, Routing/ImplicitRouteBinding.php, Routing/RouteBinding.php |
| laravel-framework | semantic | HTTP response construction and headers | none | src/Illuminate/Http/Response.php | Http/Exceptions/HttpResponseException.php, Contracts/Routing/ResponseFactory.php, Cookie/Middleware/AddQueuedCookiesToResponse.php |
| laravel-framework | semantic | database query builder and fluent SQL interface | none | src/Illuminate/Database/Query/Builder.php | Contracts/Database/Query/Builder.php, Validation/DatabasePresenceVerifierInterface.php, Contracts/Database/Eloquent/Builder.php |
| laravel-framework | semantic | event dispatching and listener registration | 6 | src/Illuminate/Events/Dispatcher.php | Routing/PendingSingletonResourceRegistration.php, Routing/PendingResourceRegistration.php, View/Concerns/ManagesEvents.php |
| laravel-framework | semantic | validation rules and error message collection | none | src/Illuminate/Validation/Validator.php | Validation/Rules/Email.php, Validation/Rules/File.php, Session/Store.php |
| laravel-framework | architecture | how middleware is applied through the pipeline | 5 | src/Illuminate/Pipeline/Pipeline.php | Contracts/Pipeline/Pipeline.php, Support/Facades/Pipeline.php, Validation/Rules/Password.php |
| laravel-framework | architecture | how the application bootstraps and registers service providers | 10 | src/Illuminate/Foundation/Application.php | Support/DefaultProviders.php, Testing/ParallelTestingServiceProvider.php, Support/ServiceProvider.php |
| laravel-framework | architecture | how Blade templates are compiled and rendered by the view factory | 10 | src/Illuminate/View/Factory.php | View/Compilers/BladeCompiler.php, Foundation/Exceptions/Renderer/Mappers/BladeMapper.php, Routing/CompiledRouteCollection.php |
| rack | semantic | building and sending an HTTP reply with headers and body | 4 | lib/rack/response.rb | body_proxy.rb, request.rb, headers.rb |
| rack | architecture | URL path mapping across mounted apps | none | lib/rack/urlmap.rb | sendfile.rb, request.rb, multipart/uploaded_file.rb |
| rack | semantic | serving a file index page for a folder on disk | 6 | lib/rack/directory.rb | files.rb, static.rb, mock |
| rack | semantic | utility methods for parameter parsing and URL encoding | 5 | lib/rack/utils.rb | method_override.rb, query_parser.rb, request.rb |
| rack | semantic | splitting multipart/form-data bodies into individual fields | 4 | lib/rack/multipart.rb | request.rb, multipart/parser.rb, multipart/uploaded_file.rb |
| rails | architecture | application boot process and initialization | 8 | railties/lib/rails/application.rb | command/actions.rb, commands/boot/boot_command.rb, generators/rails/app/app_generator.rb |
| rails | semantic | path management for rails apps | none | railties/lib/rails/paths.rb | generators/rails/plugin/plugin_generator.rb, command.rb, command/base.rb |
| rails | symbol | Application | 5 | railties/lib/rails/application.rb | commands/application/application_command.rb, generators/rails/application_record/application_record_generator.rb, command/actions.rb |
| rails | semantic | Rails command dispatch and subcommand routing | none | railties/lib/rails/command.rb | commands/routes/routes_command.rb, command/base.rb, commands/unused_routes/unused_routes_command.rb |
| rails | architecture | how railties are sorted by initialization dependency | none | railties/lib/rails/railtie.rb | generators.rb, engine/railties.rb, generators/app_base.rb |
| rails | architecture | engine middleware insertion and plugin loading | 4 | railties/lib/rails/engine.rb | generators/rails/plugin/plugin_generator.rb, commands/plugin/plugin_command.rb, commands/middleware/middleware_command.rb |
| tokio | architecture | how spawned tasks are scheduled onto threads | none | tokio/src/runtime/scheduler/multi_thread/worker.rs | runtime/metrics/runtime.rs, runtime/scheduler/current_thread/mod.rs, runtime/scheduler/multi_thread/handle/metrics.rs |
| tokio | architecture | how the timer wheel tracks sleep deadlines | 10 | tokio/src/runtime/time/wheel/level.rs | time/sleep.rs, runtime/time_alt/timer.rs, runtime/scheduler/mod.rs |
| tokio | semantic | running non-async blocking code inside the async runtime | 4 | tokio/src/task/blocking.rs | runtime/blocking/pool.rs, runtime/task/state.rs, runtime/context/blocking.rs |
| tokio | architecture | how tasks that are not Send can run on a single thread | none | tokio/src/task/local.rs | runtime/time_alt/cancellation_queue/tests.rs, runtime/scheduler/multi_thread/worker.rs, runtime/scheduler/current_thread/mod.rs |
| tokio | semantic | waiting for any of several futures to complete | none | tokio/src/macros/select.rs | io/util/buf_stream.rs, runtime/task/harness.rs, sync/oneshot.rs |
| tokio | semantic | watching a value and being notified when it changes | none | tokio/src/sync/watch.rs | util/idle_notified_set.rs, runtime/task/atomic_notified.rs, runtime/task/state.rs |
| tokio | semantic | collecting results from a dynamic set of spawned tasks | none | tokio/src/task/join_set.rs | runtime/metrics/runtime.rs, runtime/scheduler/current_thread/mod.rs, runtime/scheduler/multi_thread/handle/metrics.rs |
| tokio | semantic | integrating a non-async file descriptor with the tokio reactor | none | tokio/src/io/async_fd.rs | fs/remove_file.rs, fs/symlink_file.rs, fs/file/tests.rs |
| tokio | semantic | async file I/O operations | 7 | tokio/src/fs/file.rs | runtime/scheduler/multi_thread/stats.rs, runtime/metrics/runtime.rs, fs/remove_file.rs |
| tokio | symbol | Runtime | 6 | tokio/src/runtime/runtime.rs | runtime/context/runtime.rs, runtime/local_runtime/runtime.rs, runtime/context/runtime_mt.rs |
| trpc | semantic | how input validation and parsing works for procedures | 4 | packages/server/src/unstable-core-do-not-import/parser.ts | unstable-core-do-not-import/procedureBuilder.ts, unstable-core-do-not-import/middleware.ts, unstable-core-do-not-import/transformer.ts |
| trpc | architecture | how HTTP requests are resolved to tRPC procedures | none | packages/server/src/unstable-core-do-not-import/http/resolveResponse.ts | rpc.ts, @trpc/server/rpc.ts, unstable-core-do-not-import/rpc/envelopes.ts |
| trpc | architecture | how server-sent events and subscriptions are streamed to the client | 6 | packages/server/src/unstable-core-do-not-import/stream/sse.ts | unstable-core-do-not-import/rootConfig.ts, unstable-core-do-not-import/transformer.ts, unstable-core-do-not-import/clientish/inferrable.ts |
| trpc | architecture | how tRPC is initialized with root config and context factory | 5 | packages/server/src/unstable-core-do-not-import/initTRPC.ts | unstable-core-do-not-import/rootConfig.ts, unstable-core-do-not-import/clientish/inferrable.ts, unstable-core-do-not-import/router.ts |
| trpc | semantic | WebSocket adapter for real-time tRPC subscriptions | 5 | packages/server/src/adapters/ws.ts | rpc.ts, unstable-core-do-not-import/stream/jsonl.ts, @trpc/server/rpc.ts |
| trpc | architecture | how tRPC procedures are defined and chained with input and output validation | 10 | packages/server/src/unstable-core-do-not-import/procedure.ts | unstable-core-do-not-import/parser.ts, unstable-core-do-not-import/middleware.ts, unstable-core-do-not-import/procedureBuilder.ts |
| messagepack-csharp | semantic | how collections and arrays are serialized | none | src/MessagePack/Formatters/CollectionFormatter.cs | MessagePackStreamReader.Arrays.cs, Formatters/EnumAsStringFormatter`1.cs, MessagePackWriter.cs |
| messagepack-csharp | semantic | how enums are serialized as integers or strings | none | src/MessagePack/Resolvers/DynamicEnumResolver.cs | Formatters/EnumAsStringFormatter`1.cs, Resolvers/DynamicEnumAsStringResolver.cs, Resolvers/DynamicEnumAsStringIgnoreCaseResolver.cs |
| messagepack-csharp | symbol | MessagePackSerializer | 5 | src/MessagePack/MessagePackSerializer.cs | MessagePackSerializerOptions.cs, MessagePackSerializer.NonGeneric.cs, MessagePackSerializer+Typeless.cs |
| ktor | architecture | how the HttpClient is configured with plugins and an engine | 6 | ktor-client/ktor-client-core/common/src/io/ktor/client/HttpClient.kt | io/ktor/client/engine/HttpClientEngineCapability.kt, io/ktor/client/engine/HttpClientEngine.kt, io/ktor/client/engine/HttpClientEngineBase.kt |
| ktor | architecture | how request and response pipelines process interceptors | 8 | ktor-client/ktor-client-core/common/src/io/ktor/client/request/HttpRequestPipeline.kt | io/ktor/client/plugins/HttpCallValidator.kt, io/ktor/client/plugins/sse/builders.kt, io/ktor/client/request/HttpRequest.kt |
| ktor | semantic | how HTTP status codes are checked and exceptions raised on failure | 10 | ktor-client/ktor-client-core/common/src/io/ktor/client/plugins/HttpCallValidator.kt | io/ktor/client/network/sockets/TimeoutExceptions.common.kt, io/ktor/client/plugins/cache/HttpCacheEntry.kt, io/ktor/client/request/HttpRequest.kt |
| ktor | semantic | how HTTP redirects are followed automatically | none | ktor-client/ktor-client-core/common/src/io/ktor/client/plugins/HttpRedirect.kt | io/ktor/client/request/HttpRequest.kt, io/ktor/client/HttpClientConfig.kt, io/ktor/client/HttpClient.kt |
| ktor | semantic | how server-sent events are received and parsed from a streaming response | 6 | ktor-client/ktor-client-core/common/src/io/ktor/client/plugins/sse/SSE.kt | io/ktor/client/plugins/sse/builders.kt, io/ktor/client/statement/HttpStatement.kt, io/ktor/client/utils/ClientEvents.kt |
| ktor | architecture | how the HttpClient plugin installation and configuration pipeline works | 4 | ktor-client/ktor-client-core/common/src/io/ktor/client/plugins/api/ClientPluginBuilder.kt | io/ktor/client/plugins/HttpClientPlugin.kt, io/ktor/client/plugins/api/CreatePluginUtils.kt, io/ktor/client/HttpClient.kt |
| cats | architecture | how Monad composes dependent effectful computations with flatMap | 8 | core/src/main/scala/cats/Monad.scala | cats/FlatMap.scala, cats/syntax/flatMap.scala, cats/CommutativeFlatMap.scala |
| cats | semantic | how Chain provides O(1) concatenation as an alternative to List | 5 | core/src/main/scala/cats/data/Chain.scala | cats/syntax/nonEmptyAlternative.scala, cats/Alternative.scala, cats/NonEmptyAlternative.scala |
| cats | semantic | how natural transformations map between type constructors | none | core/src/main/scala/cats/arrow/FunctionK.scala | cats/FlatMap.scala, cats/CoflatMap.scala, cats/CommutativeFlatMap.scala |
| cats | symbol | Monad | 4 | core/src/main/scala/cats/Monad.scala | cats/syntax/monadError.scala, cats/syntax/monad.scala, cats/data/OptionT.scala |
| cats | symbol | Foldable | 4 | core/src/main/scala/cats/Foldable.scala | cats/syntax/foldable.scala, cats/syntax/unorderedFoldable.scala, cats/UnorderedFoldable.scala |
| alamofire | semantic | how URL query parameters are encoded from Encodable values | 4 | Source/Features/URLEncodedFormEncoder.swift | Core/ParameterEncoding.swift, Core/Session.swift, Core/ParameterEncoder.swift |
| serde | semantic | standard library type Serialize implementations | 4 | serde_core/src/ser/impls.rs | serde/src/private/ser.rs, serde_derive/src/ser.rs, serde_core/src/ser/mod.rs |
| serde | semantic | standard library type Deserialize implementations | none | serde_core/src/de/impls.rs | serde/src/private/de.rs, serde_derive/src/de.rs, serde_core/src/de/mod.rs |
| serde | architecture | how serde handles sequences and maps during serialization | 7 | serde_core/src/ser/mod.rs | serde/src/private/ser.rs, serde/src/private/de.rs, serde_core/src/lib.rs |
| serde | architecture | how serde handles lifetime-bound deserialization and borrowed data | 8 | serde_core/src/de/mod.rs | serde_derive/src/bound.rs, serde_derive/src/de.rs, serde_derive/src/ser.rs |
| serde | semantic | derive proc macro entry point and registered derives | none | serde_derive/src/lib.rs | serde_core/src/de/mod.rs, serde/src/private/de.rs, serde_core/src/ser/mod.rs |
| serde | symbol | Serialize | 4 | serde_core/src/ser/mod.rs | serde_derive/src/internals/name.rs, serde_derive/src/ser.rs, serde_core/src/ser/impls.rs |
| serde | symbol | Visitor | 5 | serde_core/src/de/mod.rs | serde_derive/src/ser.rs, serde_core/src/de/impls.rs, serde_core/src/de/value.rs |
| zod | semantic | union and discriminated union schema types | 6 | packages/zod/src/v4/core/schemas.ts | v3/benchmarks/discriminatedUnion.ts, v4/core/api.ts, v3/types.ts |
| zod | semantic | optional and nullable type wrappers | 4 | packages/zod/src/v4/core/schemas.ts | v3/types.ts, v4/mini/schemas.ts, v4/classic/schemas.ts |
| zod | semantic | v3 compatibility error types and ZodError | 7 | packages/zod/src/v3/errors.ts | v3/types.ts, v3/ZodError.ts, v3/helpers/errorUtil.ts |
| zod | semantic | ZodDefault and ZodCatch schema wrappers that supply fallback values on parse failure | 4 | packages/zod/src/v4/core/schemas.ts | v4/core/json-schema-processors.ts, v3/standard-schema.ts, v4/core/standard-schema.ts |
| zod | semantic | enum schema types for literal value sets | 10 | packages/zod/src/v4/core/schemas.ts | v4/core/util.ts, v3/ZodError.ts, v3/types.ts |
| nlohmann-json | semantic | JSON serialization to string output | 6 | include/nlohmann/detail/output/serializer.hpp | detail/output/output_adapters.hpp, detail/string_concat.hpp, detail/output/binary_writer.hpp |
| nlohmann-json | semantic | exception types for parse and type errors | 4 | include/nlohmann/detail/exceptions.hpp | detail/iterators/iterator_traits.hpp, detail/input/parser.hpp, detail/input/json_sax.hpp |
| nlohmann-json | architecture | how to_json serializes a custom C++ type to JSON | 5 | include/nlohmann/detail/conversions/to_json.hpp | detail/json_custom_base_class.hpp, json.hpp, detail/string_concat.hpp |
| nlohmann-json | semantic | iterator implementation for JSON arrays and objects | none | include/nlohmann/detail/iterators/iter_impl.hpp | detail/iterators/internal_iterator.hpp, detail/iterators/json_reverse_iterator.hpp, detail/iterators/primitive_iterator.hpp |
| phoenix | architecture | how Phoenix routes are defined and dispatched to controller actions | 7 | lib/phoenix/router.ex | phoenix/controller.ex, phoenix/router/resource.ex, phoenix/verified_routes.ex |
| phoenix | architecture | how Phoenix logs request and response lifecycle events | 5 | lib/phoenix/logger.ex | phoenix/socket/transport.ex, phoenix/controller.ex, phoenix/socket.ex |
| phoenix | architecture | how channels handle incoming messages and replies | none | lib/phoenix/channel.ex | phoenix/transports/long_poll.ex, phoenix/channel/server.ex, phoenix/debug.ex |
| phoenix | architecture | named URL generation from route helpers | 7 | lib/phoenix/router.ex | phoenix/router/helpers.ex, phoenix/verified_routes.ex, phoenix/digester.ex |
| axum | architecture | how extractors implement FromRequest and FromRequestParts | none | axum/src/extract/mod.rs | middleware/from_extractor.rs, extract/state.rs, extract/query.rs |
| axum | semantic | State extractor for sharing application state across handlers | 7 | axum/src/extract/state.rs | middleware/from_extractor.rs, routing/method_routing.rs, middleware/map_response.rs |
| axum | semantic | BoxedIntoRoute and type-erased route storage | none | axum/src/routing/route.rs | boxed.rs, routing/mod.rs, response/mod.rs |
| axum | semantic | parsing uploaded binary file parts from HTTP requests | none | axum/src/extract/multipart.rs | extract/ws.rs, middleware/from_extractor.rs, extract/query.rs |
| axum | symbol | Router | 4 | axum/src/routing/mod.rs | routing/path_router.rs, extract/connect_info.rs, boxed.rs |
| axum | symbol | FromRequest | none | axum/src/extract/mod.rs | middleware/from_extractor.rs, extract/state.rs, json.rs |
| vitest | architecture | how vitest statically collects describe it and test block locations for test discovery | 4 | packages/vitest/src/node/ast-collect.ts | utils/test-helpers.ts, types/module-locations.ts, runtime/workers/init.ts |
| vitest | architecture | how beforeAll afterAll and lifecycle hooks affect the test execution order | 9 | packages/vitest/src/node/test-run.ts | runtime/runners/test.ts, types/worker.ts, node/types/config.ts |
| vitest | architecture | how vitest initializes worker threads for parallel test execution | none | packages/vitest/src/runtime/workers/init.ts | node/pools/workers/threadsWorker.ts, node/pools/workers/vmThreadsWorker.ts, runtime/workers/vmThreads.ts |
| vitest | semantic | module mocker for intercepting and replacing module imports at runtime | none | packages/vitest/src/runtime/moduleRunner/moduleMocker.ts | node/reporters/reported-tasks.ts |
| vitest | semantic | task state and task result tracking | none | packages/vitest/src/utils/tasks.ts | node/reporters/reported-tasks.ts, types/global.ts, typecheck/typechecker.ts |
| vitest | semantic | project-level configuration and workspace projects | 5 | packages/vitest/src/node/project.ts | node/projects/resolveProjects.ts, node/types/config.ts, node/plugins/workspace.ts |
| vitest | symbol | Vitest | 5 | packages/vitest/src/node/core.ts | runtime/moduleRunner/startVitestModuleRunner.ts, node/plugins/vitestResolver.ts, node/plugins/index.ts |
| newtonsoft-json | architecture | JsonSerializer core serialization and deserialization engine | 6 | Src/Newtonsoft.Json/JsonSerializer.cs | Serialization/JsonSerializerProxy.cs, Utilities/FSharpUtils.cs, Serialization/JsonSerializerInternalBase.cs |
| newtonsoft-json | semantic | JsonWriter base class and token writing API | 7 | Src/Newtonsoft.Json/JsonWriter.cs | Serialization/JsonSerializerInternalBase.cs, JsonTextWriter.Async.cs, JsonWriterException.cs |
| newtonsoft-json | semantic | JsonException and JSON error types | 5 | Src/Newtonsoft.Json/JsonException.cs | Schema/JsonSchemaException.cs, JsonReaderException.cs, JsonSerializationException.cs |
| newtonsoft-json | symbol | JsonConverter | 4 | Src/Newtonsoft.Json/JsonConverter.cs | JsonConverterCollection.cs, JsonConverterAttribute.cs, Serialization/JsonFormatterConverter.cs |
| dapper | architecture | how IDataReader is consumed and results materialized | 4 | Dapper/SqlMapper.cs | SqlMapper.GridReader.Async.cs, SqlMapper.GridReader.cs, SqlMapper.IDataReader.cs |
| dapper | semantic | transaction support in Dapper queries | 9 | Dapper/SqlMapper.cs | FeatureSupport.cs, SqlMapper.Settings.cs, CommandDefinition.cs |
| dapper | symbol | SqlMapper | none | Dapper/SqlMapper.cs | SqlMapper.DontMap.cs, SqlMapper.IParameterCallbacks.cs, SqlMapper.DeserializerState.cs |
| kotlinx-coroutines | semantic | withContext for switching coroutine dispatcher context | 10 | kotlinx-coroutines-core/common/src/Builders.common.kt | CoroutineDispatcher.kt, CloseableCoroutineDispatcher.kt, MainCoroutineDispatcher.kt |
| exposed | semantic | Column definition and column types in Exposed | none | exposed-core/src/main/kotlin/org/jetbrains/exposed/v1/core/Column.kt | org/jetbrains/exposed/v1/core/WindowFunction.kt, org/jetbrains/exposed/v1/core/statements/api/ExposedDatabaseMetadata.kt, org/jetbrains/exposed/v1/core/vendors/DatabaseDialect.kt |
| exposed | semantic | Transaction block and database session management | 4 | exposed-core/src/main/kotlin/org/jetbrains/exposed/v1/core/Transaction.kt, exposed-core/src/main/kotlin/org/jetbrains/exposed/v1/core/transactions/Transactions.kt | org/jetbrains/exposed/v1/core/DatabaseConfig.kt, org/jetbrains/exposed/v1/core/transactions/TransactionInterface.kt, org/jetbrains/exposed/v1/core/transactions/TransactionManagersContainer.kt |
| exposed | semantic | insert insertAndGetId and batch insert operations | 8 | exposed-core/src/main/kotlin/org/jetbrains/exposed/v1/core/statements/InsertStatement.kt | org/jetbrains/exposed/v1/core/statements/SQLServerBatchInsertStatement.kt, org/jetbrains/exposed/v1/core/statements/BatchInsertStatement.kt, org/jetbrains/exposed/v1/core/statements/StatementBuilder.kt |
| exposed | semantic | Op and SqlExpressionBuilder for composing WHERE conditions | 4 | exposed-core/src/main/kotlin/org/jetbrains/exposed/v1/core/Op.kt | org/jetbrains/exposed/v1/core/Table.kt, org/jetbrains/exposed/v1/core/OpBuilder.kt, org/jetbrains/exposed/v1/core/SQLExpressionBuilder.kt |
| exposed | semantic | SchemaUtils for creating and dropping database tables | none | exposed-jdbc/src/main/kotlin/org/jetbrains/exposed/v1/jdbc/SchemaUtils.kt | org/jetbrains/exposed/v1/core/SchemaUtilityApi.kt, org/jetbrains/exposed/v1/core/vendors/SchemaMetadata.kt, org/jetbrains/exposed/v1/core/Schema.kt |
| exposed | architecture | how expressions and SQL operators are composed in Exposed | none | exposed-core/src/main/kotlin/org/jetbrains/exposed/v1/core/Expression.kt | org/jetbrains/exposed/v1/core/Function.kt, org/jetbrains/exposed/v1/core/statements/UpsertStatement.kt, org/jetbrains/exposed/v1/core/statements/BatchUpsertStatement.kt |
| exposed | semantic | index and unique constraint definition on tables | 4 | exposed-core/src/main/kotlin/org/jetbrains/exposed/v1/core/Constraints.kt | org/jetbrains/exposed/v1/core/Table.kt, org/jetbrains/exposed/v1/core/WindowFunction.kt, org/jetbrains/exposed/v1/core/vendors/H2.kt |
| exposed | semantic | ColumnType mapping between Kotlin types and SQL types | 6 | exposed-core/src/main/kotlin/org/jetbrains/exposed/v1/core/ColumnType.kt | org/jetbrains/exposed/v1/core/vendors/H2.kt, org/jetbrains/exposed/v1/core/statements/api/ExposedDatabaseMetadata.kt, org/jetbrains/exposed/v1/core/vendors/DatabaseDialect.kt |
| exposed | symbol | Transaction | 6 | exposed-core/src/main/kotlin/org/jetbrains/exposed/v1/core/Transaction.kt | org/jetbrains/exposed/v1/core/transactions/TransactionScope.kt, org/jetbrains/exposed/v1/core/transactions/Transactions.kt, org/jetbrains/exposed/v1/core/transactions/TransactionInterface.kt |
| circe | architecture | HCursor and cursor navigation for traversing JSON trees | 6 | modules/core/shared/src/main/scala/io/circe/HCursor.scala | io/circe/cursor/ArrayCursor.scala, io/circe/cursor/TopCursor.scala, io/circe/cursor/ObjectCursor.scala |
| circe | semantic | ACursor abstract cursor for JSON traversal with error accumulation | 4 | modules/core/shared/src/main/scala/io/circe/ACursor.scala | io/circe/cursor/ArrayCursor.scala, io/circe/cursor/ObjectCursor.scala, io/circe/cursor/TopCursor.scala |
| circe | architecture | how circe parses a JSON string into a Json value | none | modules/core/shared/src/main/scala/io/circe/Parser.scala | io/circe/JsonObject.scala, io/circe/Json.scala, io/circe/JsonNumber.scala |
| http4s | semantic | Headers and individual Header types | none | core/shared/src/main/scala/org/http4s/Headers.scala | org/http4s/headers/HeaderCompanion.scala, org/http4s/MimeDB.scala, org/http4s/headers/Access-Control-Allow-Headers.scala |
| http4s | semantic | Uri parsing and construction | none | core/shared/src/main/scala/org/http4s/Uri.scala | org/http4s/internal/parsing/Rfc3986.scala, org/http4s/internal/parsing/Rfc4648.scala, org/http4s/internal/parsing/AuthRules.scala |
| http4s | architecture | how Kleisli and OptionT power the Http and HttpRoutes algebra | 6 | core/shared/src/main/scala/org/http4s/Http.scala | org/http4s/syntax/KleisliSyntax.scala, org/http4s/HttpRoutes.scala, org/http4s/ContextRoutes.scala |
| http4s | semantic | Status codes and HTTP response status | 4 | core/shared/src/main/scala/org/http4s/Status.scala | org/http4s/MessageFailure.scala, org/http4s/ResponsePrelude.scala, org/http4s/MimeDB.scala |
| http4s | semantic | Media type and content type handling | 6 | core/shared/src/main/scala/org/http4s/MediaType.scala | org/http4s/headers/Content-Type.scala, org/http4s/headers/X-Content-Type-Options.scala, org/http4s/StaticFile.scala |
| http4s | semantic | Entity body representation and streaming | 4 | core/shared/src/main/scala/org/http4s/Entity.scala | org/http4s/EntityEncoder.scala, org/http4s/Message.scala, org/http4s/package.scala |
| vapor | architecture | how Application configures and boots a Vapor server | 7 | Sources/Vapor/Application.swift | HTTP/Server/Application+HTTP+Server.swift, HTTP/Server/HTTPServer.swift, Server/Server.swift |
| vapor | architecture | how routes are registered on the RoutesBuilder | 5 | Sources/Vapor/Routing/RoutesBuilder+Method.swift | Routing/RoutesBuilder.swift, Routing/RoutesBuilder+Middleware.swift, Routing/RoutesBuilder+Group.swift |
| vapor | semantic | Request type and HTTP request representation in Vapor | 4 | Sources/Vapor/Request/Request.swift | HTTP/Headers/HTTPMediaType.swift, HTTP/Server/HTTPServer.swift, Utilities/VaporSendableMetadataType.swift |
| vapor | semantic | Sessions and session driver for server-side session storage | 8 | Sources/Vapor/Sessions/Session.swift | Sessions/SessionDriver.swift, Concurrency/AsyncSessionDriver.swift, Sessions/MemorySessions.swift |
| vapor | semantic | how route groups and route collections compose routes | 4 | Sources/Vapor/Routing/RoutesBuilder+Group.swift | Routing/RouteCollection.swift, Routing/RoutesBuilder.swift, Routing/Routes.swift |
| vapor | semantic | CORS middleware for cross-origin resource sharing | 4 | Sources/Vapor/Middleware/CORSMiddleware.swift | Middleware/Middleware.swift, Deprecations/CORSMiddleware+AllowOriginSetting.swift, Middleware/FileMiddleware.swift |
| vapor | semantic | HTTP status codes and media types in Vapor | none | Sources/Vapor/HTTP/HTTPStatus.swift | HTTP/Headers/HTTPMediaType.swift, HTTP/Server/HTTPServer.swift, Utilities/VaporSendableMetadataType.swift |
| vapor | symbol | Application | none | Sources/Vapor/Application.swift | HTTP/Application+HTTP.swift, Passwords/Application+Passwords.swift, Responder/Application+Responder.swift |
| snapkit | semantic | how offset and inset modifiers adjust the constant value of a constraint | 5 | Sources/ConstraintMakerEditable.swift | ConstraintOffsetTarget.swift, ConstraintInsetTarget.swift, ConstraintConstantTarget.swift |
| snapkit | architecture | how the snp property bridges UIView and NSView into the SnapKit DSL | 4 | Sources/ConstraintView+Extensions.swift | ConstraintDSL.swift, ConstraintLayoutSupportDSL.swift, ConstraintLayoutGuideDSL.swift |
| snapkit | symbol | ConstraintMaker | 4 | Sources/ConstraintMaker.swift | ConstraintMakerPrioritizable.swift, ConstraintMakerExtendable.swift, ConstraintMakerEditable.swift |
| plug | semantic | URL-encoded form body parser | 8 | lib/plug/parsers/urlencoded.ex | conn.ex, debugger.ex, conn/query.ex |
| plug | semantic | Plug.Session for cookie and server-side session management | 4 | lib/plug/session.ex | session/cookie.ex, session/store.ex, conn.ex |
| ecto | semantic | preload for loading associations eagerly | 4 | lib/ecto/query.ex | query/builder/preload.ex, repo/preloader.ex, association.ex |
| abseil-cpp | semantic | absl::StrSplit and StrJoin for string splitting and joining | 6 | absl/strings/str_split.h | strings/str_join.h, strings/str_split_benchmark.cc, strings/str_join_benchmark.cc |
| abseil-cpp | semantic | absl logging macros ABSL_LOG and ABSL_CHECK | none | absl/log/absl_log.h | log/internal/log_sink_set.cc, log/internal/check_op.cc, log/internal/log_sink_set.h |
| abseil-cpp | architecture | absl::Hash and the Abseil hashing framework | none | absl/hash/hash.h | abseil.podspec.gen.py, hash/internal/hash.h, hash/hash_testing.h |
| fmtlib | semantic | format_error and error handling for invalid format strings | 5 | include/fmt/base.h | format-inl.h, format.h, os.h |
| fmtlib | semantic | fmt::arg named arguments for use in format strings | 4 | include/fmt/args.h | base.h, fmt-c.h, format.h |
| fmtlib | symbol | formatter | 4 | include/fmt/format.h | ranges.h, base.h, chrono.h |
| curl | architecture | how curl resolves and connects to a remote host | none | lib/connect.c | vauth/vauth.c, http.c, cfilters.c |
| curl | semantic | how a new easy handle is initialized with default settings | none | lib/url.c | http2.c, vquic/curl_ngtcp2.c, vtls/schannel_int.h |
| curl | architecture | how the easy interface wraps the multi interface for synchronous use | 10 | lib/easy.c | multi.c, asyn-ares.c, cf-socket.h |
| curl | semantic | how curl checks if HTTP If-Modified-Since condition is met | none | lib/transfer.c | http.c, http_proxy.c, curlx/version_win32.h |
| curl | architecture | connection filter chain setup for proxies and TLS | none | lib/connect.c | cfilters.c, smb.c, openldap.c |
| curl | architecture | how SSL is configured on a connection | 6 | lib/url.c | vtls/vtls_int.h, vtls/vtls.c, vtls/vtls_scache.c |
| curl | semantic | freeing all resources when closing an easy handle | none | lib/url.c | multi.c, cfilters.c, slist.c |
| curl | architecture | how HTTP proxy tunnel CONNECT method is initiated | 5 | lib/http.c | http_proxy.c, cf-h1-proxy.c, http_proxy.h |
| redis | semantic | how Redis implements the SET command with options like NX, EX, PX | none | src/t_string.c | t_hash.c, redis-trib.rb, module.c |
| redis | architecture | server startup initialization and configuration loading | 9 | src/server.c | acl.c, server.h, rdb.c |
| redis | architecture | how Redis cluster handles slot assignment and routing | 6 | src/cluster.c | cluster_slot_stats.h, cluster_slot_stats.c, redis-cli.c |
| redis | semantic | how set intersection and union operations work | 5 | src/t_set.c | server.c, server.h, module.c |
| libuv | semantic | file system operations like read write open stat | 7 | src/unix/fs.c | win/fs.c, win/winapi.h, win/pipe.c |
| libuv | semantic | resolving hostnames asynchronously using the thread pool | none | src/unix/getaddrinfo.c | win/thread.c, unix/thread.c, unix/core.c |
| libuv | semantic | file system event watching with inotify or kqueue | 9 | src/unix/fsevents.c | unix/kqueue.c, win/fs-event.c, unix/linux.c |
| libuv | semantic | idle and prepare handle callbacks before blocking | 7 | src/unix/core.c | win/stream.c, unix/internal.h, unix/stream.c |
| libuv | semantic | network interface address enumeration | 4 | src/unix/bsd-ifaddrs.c | unix/os390.c, unix/sunos.c, unix/linux.c |
| libuv | semantic | libuv handle reference counting and close | none | src/uv-common.c | unix/core.c, win/handle.c, win/pipe.c |
| bats-core | semantic | how bats formats test result output | 7 | lib/bats-core/formatter.bash | bats-core/test_functions.bash, bats-core/common.bash, bats-core/preprocessing.bash |
| aeson | architecture | how JSON encoding produces Encoding without materializing a Value | 8 | src/Data/Aeson/Encoding.hs | Types/ToJSON.hs, Encoding/Internal.hs, Types/FromJSON.hs |
| aeson | semantic | how Key type is used as object field identifier | 6 | src/Data/Aeson/KeyMap.hs | Types/Internal.hs, TH.hs, Types/ToJSON.hs |
| telescope.nvim | architecture | how Picker:find opens a floating window and starts fuzzy finding | 4 | lua/telescope/pickers.lua | pickers/window.lua, builtin/__files.lua, sorters.lua |
| telescope.nvim | architecture | how finders feed entries into a picker results buffer | 10 | lua/telescope/finders.lua | testharness/runner.lua, actions/utils.lua, previewers/buffer_previewer.lua |
| telescope.nvim | architecture | how telescope actions map keys to picker operations | 7 | lua/telescope/actions/init.lua | mappings.lua, actions/state.lua, init.lua |
| lazy.nvim | architecture | how lazy.nvim loads a plugin on demand when its trigger fires | none | lua/lazy/core/loader.lua | core/handler/event.lua, init.lua, core/util.lua |
| lazy.nvim | architecture | how plugin installations and updates are managed with tasks | 4 | lua/lazy/manage/init.lua | status.lua, view/render.lua, core/plugin.lua |
| lazy.nvim | semantic | how the lockfile pins plugin commits for reproducible installs | 8 | lua/lazy/manage/lock.lua | view/init.lua, manage/init.lua, view/render.lua |
| lazy.nvim | architecture | spawning and aborting async subprocess commands with uv | 6 | lua/lazy/manage/process.lua | view/commands.lua, docs.lua, view/config.lua |
| lazy.nvim | semantic | how lazy.nvim config is validated and merged with defaults | 4 | lua/lazy/core/config.lua | minit.lua, example.lua, core/plugin.lua |
| zig | semantic | how std.json parses JSON from a slice into a typed struct | 6 | lib/std/json/static.zig | json.zig, json/dynamic.zig, zig/AstGen.zig |
| zig | semantic | how std.testing.expect and expectEqual assert conditions in tests | none | lib/std/testing.zig | crypto/Certificate.zig, crypto/codecs/asn1/der/Decoder.zig, crypto/timing_safe.zig |
| zig | semantic | how std.fmt.parseInt parses a string to an integer | 8 | lib/std/fmt.zig | zon/parse.zig, fmt/parse_float/parse.zig, zig.zig |
| bash-it | semantic | color definitions and terminal color support | none | lib/colors.bash | completion/available/git_flow_avh.completion.bash, themes/dulcie/dulcie.theme.bash, themes/parrot/parrot.theme.bash |
| bash-it | semantic | how tab completion scripts are sourced and activated | none | lib/completion.bash | plugins/available/osx.plugin.bash, completion/available/composer.completion.bash, completion/available/gradle.completion.bash |
| bash-it | symbol | node version manager nvm integration | 8 | plugins/available/node.plugin.bash | themes/base.theme.bash, plugins/available/nvm.plugin.bash, themes/barbuk/barbuk.theme.bash |
| bash-it | semantic | bash-it utility functions for string manipulation | none | lib/utilities.bash | install.sh, lib/preexec.bash, completion/available/dmidecode.completion.bash |
| bash-it | semantic | bash-it main entry point and initialization | none | bash_it.sh | lib/helpers.bash, plugins/available/osx-timemachine.plugin.bash, completion/available/dotnet.completion.bash |
| pandoc | architecture | how pandoc reads and parses Markdown into an AST | 7 | Readers/Markdown.hs | Readers/EPUB.hs, Writers/Markdown.hs, Readers/ODT/StyleReader.hs |
| pandoc | architecture | how the PandocMonad typeclass abstracts IO for readers and writers | none | Class.hs | Class/PandocIO.hs, Class/PandocMonad.hs, Sources.hs |
| pandoc | semantic | how pandoc options control output format and extensions | 5 | Options.hs | Extensions.hs, Format.hs, App/OutputSettings.hs |
| pandoc | semantic | how pandoc parses table structures in documents | 10 | Parsing/GridTable.hs | Readers/Jira.hs, Writers/BBCode.hs, Readers/Muse.hs |
| pandoc | semantic | how pandoc writes CommonMark Markdown output | 4 | Writers/CommonMark.hs | Readers/CommonMark.hs, Class/PandocMonad.hs, Writers/Markdown.hs |
| pandoc | semantic | how pandoc reads RST reStructuredText documents | 6 | Readers/RST.hs | Writers/RST.hs, Readers/ODT/StyleReader.hs, Readers/Org/Blocks.hs |
| pandoc | semantic | how pandoc handles TeX math in documents | none | TeX.hs | Readers/LaTeX/Math.hs, Writers/Math.hs, Readers/HTML.hs |
| pandoc | architecture | how pandoc parses generic parsing utilities for readers | none | Parsing/General.hs | Readers/Txt2Tags.hs, Class/PandocPure.hs, Class/PandocIO.hs |
| xmonad | architecture | how xmonad handles X11 events in its event loop | 4 | Main.hs | Operations.hs, Config.hs, Core.hs |
| xmonad | semantic | how xmonad uses withDisplay to get the X11 Display handle | none | Core.hs | Operations.hs |
| xmonad | architecture | how xmonad initializes the display and root window at startup | 4 | Main.hs | Config.hs, Operations.hs, Core.hs |
| mini.nvim | semantic | how mini.comment toggles line and block comments | 4 | lua/mini/comment.lua | splitjoin.lua, doc.lua, misc.lua |
| zls | semantic | how zls provides hover information for symbols under the cursor | 4 | features/hover.zig | features/workspace_symbols.zig, print_ast.zig, zls.zig |
| zls | architecture | how zls traverses the Zig AST to resolve symbol scopes | none | ast.zig | zls.zig, features/document_symbol.zig, DocumentScope.zig |
| zls | semantic | how zls provides workspace symbol search | 4 | features/workspace_symbols.zig | Server.zig, features/completions.zig, build_runner/build_runner.zig |
| zls | semantic | how zls translates C headers for Zig interop | 9 | translate_c.zig | zls.zig, main.zig, Server.zig |
| zig-clap | semantic | how zig-clap iterates over OS process arguments | 10 | clap/args.zig | clap.zig, example/streaming-clap.zig, clap/streaming.zig |
| zig-clap | semantic | how zig-clap prints help text for all defined parameters | 4 | clap.zig | clap/codepoint_counting_writer.zig, build.zig, example/help.zig |
