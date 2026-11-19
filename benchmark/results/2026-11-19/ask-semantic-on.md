# gg-bench ask on semble's 1,251 questions at `df2cf79`, semantic ranking on

The tool built at `df2cf79` (branch `ryan/semantic-ask-2026-11-19`) was asked every question on the benchmark machine (Linux) from 14:26 to 14:58 UTC on 19 November 2026, in 2 attempts (the first stopped at its 30-minute limit after 61 repositories; the second asked the other 2), with its default ranking: words and meaning merged. `gg-bench ask` from #125's branch at `658ba18` graded it, whose code differs from `8b3b71f` (#125 merged) only by moving its unit tests to `ask/tests.rs` ([cmd-ask-semantic.sh](cmd-ask-semantic.sh), run with `MODE=on`). Local paths are replaced by `<path>`. [ask-semantic-on-files.json](ask-semantic-on-files.json) holds the files each answer ranked, the first 10 distinct per question. [ask-semantic-off.md](ask-semantic-off.md) is `fe83325` with `TRAIL_SEMANTIC=0`.

```text
Node v26.13.1, 2026-11-19 UTC
Tool: <path>/dist/bin/graft.js (0.28.0+gg)
Set: benchmark/ask/semble, 1251 questions in 63 repositories; 0 failed
```


| Set | Queries | NDCG@10 | hit@1 | hit@3 | hit@10 |
| --- | --- | --- | --- | --- | --- |
| All | 1251 | 0.794 | 0.598 | 0.841 | 0.949 |
| architecture | 344 | 0.765 | 0.532 | 0.817 | 0.922 |
| semantic | 703 | 0.797 | 0.609 | 0.846 | 0.952 |
| symbol | 204 | 0.836 | 0.672 | 0.863 | 0.985 |
| bash | 60 | 0.882 | 0.833 | 0.883 | 0.950 |
| c | 60 | 0.724 | 0.483 | 0.750 | 0.917 |
| cpp | 60 | 0.819 | 0.633 | 0.883 | 0.983 |
| csharp | 60 | 0.761 | 0.567 | 0.817 | 0.950 |
| elixir | 58 | 0.853 | 0.672 | 0.948 | 0.983 |
| go | 58 | 0.871 | 0.707 | 0.914 | 0.931 |
| haskell | 60 | 0.761 | 0.583 | 0.800 | 0.917 |
| java | 61 | 0.762 | 0.541 | 0.803 | 0.918 |
| javascript | 60 | 0.880 | 0.700 | 0.933 | 0.967 |
| kotlin | 60 | 0.742 | 0.517 | 0.833 | 0.950 |
| lua | 60 | 0.873 | 0.733 | 0.900 | 0.983 |
| php | 60 | 0.688 | 0.483 | 0.683 | 0.900 |
| python | 184 | 0.810 | 0.549 | 0.853 | 0.962 |
| ruby | 58 | 0.802 | 0.586 | 0.897 | 0.966 |
| rust | 60 | 0.703 | 0.517 | 0.750 | 0.883 |
| scala | 59 | 0.825 | 0.644 | 0.898 | 0.966 |
| swift | 53 | 0.792 | 0.547 | 0.774 | 0.981 |
| typescript | 60 | 0.701 | 0.533 | 0.733 | 0.933 |
| zig | 60 | 0.818 | 0.633 | 0.900 | 0.967 |

Misses at 3 (no relevant file among the first 3):

| Repository | Category | Query | First relevant | Relevant | First 3 returned |
| --- | --- | --- | --- | --- | --- |
| aiohttp | semantic | request and response object internals | 7 | aiohttp/client_reqrep.py | web_protocol.py, client.py, web_response.py |
| aiohttp | semantic | response streaming and payload | none | aiohttp/streams.py | client_proto.py, multipart.py, payload.py |
| aiohttp | semantic | HTTP exception types and error responses | 5 | aiohttp/web_exceptions.py | client_exceptions.py, http_exceptions.py, web_urldispatcher.py |
| aiohttp | architecture | how DNS resolution is handled asynchronously | 4 | aiohttp/resolver.py | connector.py, tracing.py, abc.py |
| aiohttp | architecture | how backpressure and flow control work in streaming | none | aiohttp/streams.py | _websocket/writer.py, payload.py, client_reqrep.py |
| fastapi | semantic | websocket endpoint implementation | 8 | fastapi/websockets.py | applications.py, exceptions.py, routing.py |
| fastapi | semantic | OpenAPI schema generation | none | fastapi/openapi/utils.py | openapi/models.py, routing.py, applications.py |
| fastapi | semantic | response model serialization | none | fastapi/encoders.py | routing.py, utils.py, _compat/v2.py |
| fastapi | semantic | running work after returning an HTTP response without blocking | 6 | fastapi/background.py | routing.py, concurrency.py, sse.py |
| fastapi | architecture | how does FastAPI run sync route functions without blocking | 5 | fastapi/concurrency.py | routing.py, param_functions.py, applications.py |
| fastapi | architecture | how are path parameters extracted and type-converted | none | fastapi/routing.py | openapi/utils.py, __init__, param_functions.py |
| fastapi | symbol | Depends | 5 | fastapi/params.py | dependencies/utils.py, param_functions.py, routing.py |
| flask | architecture | how are routes registered | 4 | src/flask/sansio/scaffold.py | cli.py, sansio/blueprints.py, sansio/app.py |
| flask | semantic | g | 6 | src/flask/globals.py | json/tag.py, helpers.py, sansio/app.py |
| httpx | architecture | how does streaming response body iteration work | 4 | httpx/_models.py | _auth.py, _exceptions.py, _content.py |
| model2vec | semantic | reducing embedding precision to smaller integer representations | 8 | model2vec/quantization.py | model.py, train/base.py, persistence/persistence.py |
| model2vec | architecture | how PCA reduces embedding dimensionality | 4 | model2vec/distill/distillation.py | distill/inference.py, model.py, quantization.py |
| pydantic | architecture | how are model fields declared and constrained | none | pydantic/fields.py | v1/types.py, v1/schema.py, json_schema.py |
| pydantic | semantic | custom field and model validators | 4 | pydantic/functional_validators.py | v1/fields.py, v1/class_validators.py, _internal/_generate_schema.py |
| pydantic | semantic | model configuration and settings | none | pydantic/config.py | v1/env_settings.py, _internal/_config.py, mypy.py |
| pydantic | semantic | alias handling for field names | 5 | pydantic/aliases.py | _internal/_fields.py, v1/env_settings.py, v1/mypy.py |
| pydantic | symbol | field_validator | 4 | pydantic/functional_validators.py | _internal/_generate_schema.py, v1/class_validators.py, _internal/_decorators_v1.py |
| pydantic | symbol | Field | 4 | pydantic/fields.py | _internal/_generate_schema.py, v1/schema.py, _internal/_fields.py |
| requests | semantic | request and response model internals | 6 | src/requests/models.py | exceptions.py, adapters.py, api.py |
| starlette | semantic | websocket connection and message handling | 4 | starlette/websockets.py | endpoints.py, testclient.py, responses.py |
| starlette | symbol | BaseHTTPMiddleware | 7 | starlette/middleware/base.py | routing.py, applications.py, schemas.py |
| starlette | symbol | Request | 8 | starlette/requests.py | testclient.py, middleware/base.py, middleware/cors.py |
| axios | semantic | request and response interceptors | none | lib/core/InterceptorManager.js | core/Axios.js, core/dispatchRequest.js, adapters/xhr.js |
| axios | symbol | Axios | 5 | lib/core/Axios.js | axios.js, core/AxiosError.js, core/AxiosHeaders.js |
| axios | architecture | axios default configuration and request/response transformers | none | lib/defaults/index.js | core/dispatchRequest.js, axios.js, adapters/http.js |
| redux | semantic | function composition utility | 4 | src/compose.ts | applyMiddleware.ts, types/middleware.ts, createStore.ts |
| gin | architecture | how validators are plugged in for struct binding | none | binding/default_validator.go | binding/binding_nomsgpack.go, binding/binding.go, binding/bson.go |
| gin | semantic | utility helpers for path detection and content-type formatting | none | utils.go | render/html.go, render/pdf.go, render/json.go |
| chi | architecture | HTTP router and middleware composition | none | mux.go | chain.go, chi.go, middleware/route_headers.go |
| chi | semantic | URL path stripping and rewriting middleware | 4 | middleware/strip.go | middleware/path_rewrite.go, middleware/clean_path.go, middleware/url_format.go |
| chi | architecture | how chi resolves named URL parameters and wildcards during routing | none | tree.go | context.go, middleware/url_format.go, chi.go |
| gson | symbol | TypeAdapter | 8 | gson/src/main/java/com/google/gson/TypeAdapter.java | src/main/java/com/google/gson/internal/bind/TypeAdapterRuntimeTypeWrapper.java, src/main/java/com/google/gson/internal/bind/JsonAdapterAnnotationTypeAdapterFactory.java, src/main/java/com/google/gson/TypeAdapterFactory.java |
| gson | architecture | how null values are handled during serialization | none | gson/src/main/java/com/google/gson/Gson.java | src/main/java/com/google/gson/JsonSerializationContext.java, src/main/java/com/google/gson/LongSerializationPolicy.java, src/main/java/com/google/gson/GsonBuilder.java |
| gson | architecture | how type adapter factories are registered and selected for a given type | none | gson/src/main/java/com/google/gson/Gson.java | src/main/java/com/google/gson/GsonBuilder.java, src/main/java/com/google/gson/internal/bind/TypeAdapterRuntimeTypeWrapper.java, src/main/java/com/google/gson/TypeAdapterFactory.java |
| commons-lang | semantic | argument validation helpers and exception rules | 7 | src/main/java/org/apache/commons/lang3/Validate.java | time/FastDatePrinter.java, exception/ContextedRuntimeException.java, exception/ContextedException.java |
| commons-lang | semantic | number parsing with defaults and range checks | 4 | src/main/java/org/apache/commons/lang3/math/NumberUtils.java | CharRange.java, time/FastDateParser.java, IntegerRange.java |
| jackson-databind | architecture | polymorphic type resolution | none | src/main/java/tools/jackson/databind/jsontype/impl/StdTypeResolverBuilder.java | AnnotationIntrospector.java, introspect/JacksonAnnotationIntrospector.java, cfg/MapperBuilder.java |
| jackson-databind | semantic | writing and serializing Java objects to JSON with configuration | 4 | src/main/java/tools/jackson/databind/ObjectWriter.java | util/NativeImageUtil.java, ObjectMapper.java, json/JsonMapper.java |
| jackson-databind | semantic | bean deserialization from JSON properties | 5 | src/main/java/tools/jackson/databind/deser/bean/BeanDeserializer.java | deser/bean/BeanDeserializerBase.java, deser/bean/BeanAsArrayDeserializer.java, ser/BeanSerializerFactory.java |
| jackson-databind | semantic | bean serialization of Java object fields to JSON | none | src/main/java/tools/jackson/databind/ser/BeanSerializer.java | ser/BeanSerializerFactory.java, ser/bean/BeanSerializerBase.java, jsonFormatVisitors/JsonObjectFormatVisitor.java |
| jackson-databind | architecture | deserialization context and error accumulation during parsing | 4 | src/main/java/tools/jackson/databind/DeserializationContext.java | ObjectMapper.java, ObjectReader.java, deser/impl/ErrorThrowingDeserializer.java |
| jackson-databind | semantic | deserialization feature flags and configuration options | 6 | src/main/java/tools/jackson/databind/DeserializationFeature.java | DeserializationConfig.java, cfg/ConfigFeature.java, DeserializationContext.java |
| jackson-databind | architecture | how the mapper resolves a deserializer for a given Java type | none | src/main/java/tools/jackson/databind/ObjectMapper.java | jsontype/TypeDeserializer.java, deser/impl/TypeWrappedDeserializer.java, jsontype/impl/NoOpTypeDeserializer.java |
| guzzle | semantic | curl-based HTTP handler and connection management | 4 | src/Handler/CurlFactory.php | Handler/CurlHandler.php, Utils.php, Handler/CurlMultiHandler.php |
| guzzle | semantic | available request options and their configuration | 5 | src/RequestOptions.php | Client.php, Handler/CurlFactory.php, ClientInterface.php |
| guzzle | semantic | exception hierarchy for HTTP and transfer errors | 4 | src/Exception/RequestException.php | Exception/TransferException.php, Utils.php, Exception/ConnectException.php |
| monolog | semantic | json log formatting | 4 | src/Monolog/Formatter/JsonFormatter.php | Formatter/NormalizerFormatter.php, Utils.php, JsonSerializableDateTimeImmutable.php |
| monolog | symbol | Logger | 4 | src/Monolog/Logger.php | Registry.php, Handler/PsrHandler.php, Handler/RollbarHandler.php |
| monolog | architecture | how log records propagate through the handler bubble chain | none | src/Monolog/Logger.php | Handler/GroupHandler.php, Handler/WhatFailureGroupHandler.php, Handler/HandlerInterface.php |
| monolog | architecture | how formatters transform log records into output strings | 4 | src/Monolog/Formatter/LineFormatter.php | Formatter/FormatterInterface.php, Formatter/HtmlFormatter.php, Handler/BrowserConsoleHandler.php |
| laravel-framework | architecture | queue connection resolution and connectors | 10 | src/Illuminate/Queue/QueueManager.php | Queue/QueueServiceProvider.php, Queue/Capsule/Manager.php, Bus/Dispatcher.php |
| laravel-framework | semantic | session store behavior | none | src/Illuminate/Session/Store.php | Session/SessionManager.php, Session/Middleware/StartSession.php, Cache/SessionStore.php |
| laravel-framework | symbol | QueueManager | 4 | src/Illuminate/Queue/QueueManager.php | Queue/QueueServiceProvider.php, Queue/Capsule/Manager.php, Queue/DatabaseQueue.php |
| laravel-framework | architecture | routing HTTP requests to controllers | none | src/Illuminate/Routing/Router.php | Routing/Route.php, Foundation/Http/Middleware/HandlePrecognitiveRequests.php, Foundation/Routing/PrecognitionControllerDispatcher.php |
| laravel-framework | semantic | route parameter binding and model resolution | 6 | src/Illuminate/Routing/Route.php | Routing/ImplicitRouteBinding.php, Routing/RouteParameterBinder.php, Routing/RouteBinding.php |
| laravel-framework | semantic | HTTP response construction and headers | none | src/Illuminate/Http/Response.php | Filesystem/FilesystemAdapter.php, Routing/ResponseFactory.php, Contracts/Routing/ResponseFactory.php |
| laravel-framework | semantic | database query builder and fluent SQL interface | none | src/Illuminate/Database/Query/Builder.php | Contracts/Database/Query/Builder.php, Contracts/Database/Eloquent/Builder.php, Database/Query/Grammars/MySqlGrammar.php |
| laravel-framework | semantic | validation rules and error message collection | none | src/Illuminate/Validation/Validator.php | Validation/Rules/Email.php, Foundation/Http/FormRequest.php, Validation/ConditionalRules.php |
| laravel-framework | architecture | how middleware is applied through the pipeline | 4 | src/Illuminate/Pipeline/Pipeline.php | Support/Facades/Pipeline.php, Contracts/Pipeline/Pipeline.php, Routing/SortedMiddleware.php |
| laravel-framework | symbol | Router | 5 | src/Illuminate/Routing/Router.php | Routing/CompiledRouteCollection.php, Routing/RouteFileRegistrar.php, Foundation/Console/RouteListCommand.php |
| laravel-framework | symbol | Container | 5 | src/Illuminate/Container/Container.php | Validation/Factory.php, Auth/Access/Gate.php, Support/Traits/CapsuleManagerTrait.php |
| laravel-framework | architecture | how Blade templates are compiled and rendered by the view factory | 7 | src/Illuminate/View/Factory.php | View/Compilers/BladeCompiler.php, Foundation/Exceptions/Renderer/Mappers/BladeMapper.php, View/Component.php |
| rack | architecture | URL path mapping across mounted apps | none | lib/rack/urlmap.rb | sendfile.rb, static.rb, directory.rb |
| rack | semantic | splitting multipart/form-data bodies into individual fields | 5 | lib/rack/multipart.rb | request.rb, multipart/parser.rb, multipart/uploaded_file.rb |
| rack | symbol | Utils | 4 | lib/rack/utils.rb | builder.rb, files.rb, runtime.rb |
| rails | semantic | path management for rails apps | 8 | railties/lib/rails/paths.rb | generators/rails/plugin/plugin_generator.rb, generators/app_base.rb, commands/credentials/credentials_command.rb |
| rails | semantic | Rails command dispatch and subcommand routing | none | railties/lib/rails/command.rb | command/base.rb, generators/actions.rb, commands/routes/routes_command.rb |
| rails | architecture | how railties are sorted by initialization dependency | 9 | railties/lib/rails/railtie.rb | application.rb, generators/app_base.rb, engine.rb |
| tokio | architecture | how spawned tasks are scheduled onto threads | none | tokio/src/runtime/scheduler/multi_thread/worker.rs | runtime/metrics/runtime.rs, runtime/scheduler/current_thread/mod.rs, runtime/blocking/pool.rs |
| tokio | architecture | how the timer wheel tracks sleep deadlines | 7 | tokio/src/runtime/time/wheel/level.rs | time/sleep.rs, runtime/time/mod.rs, runtime/time_alt/wheel/mod.rs |
| tokio | architecture | how tasks that are not Send can run on a single thread | 7 | tokio/src/task/local.rs | runtime/task/list.rs, runtime/blocking/pool.rs, runtime/scheduler/multi_thread/worker.rs |
| tokio | semantic | waiting for any of several futures to complete | 7 | tokio/src/macros/select.rs | task/mod.rs, runtime/task/harness.rs, sync/notify.rs |
| tokio | semantic | watching a value and being notified when it changes | 7 | tokio/src/sync/watch.rs | sync/notify.rs, runtime/task/state.rs, util/idle_notified_set.rs |
| tokio | semantic | collecting results from a dynamic set of spawned tasks | none | tokio/src/task/join_set.rs | runtime/metrics/runtime.rs, runtime/scheduler/current_thread/mod.rs, runtime/task_hooks.rs |
| tokio | semantic | integrating a non-async file descriptor with the tokio reactor | 6 | tokio/src/io/async_fd.rs | net/unix/pipe.rs, io/util/async_read_ext.rs, io/util/async_write_ext.rs |
| trpc | architecture | how HTTP requests are resolved to tRPC procedures | none | packages/server/src/unstable-core-do-not-import/http/resolveResponse.ts | @trpc/server/rpc.ts, unstable-core-do-not-import/rpc/envelopes.ts, rpc.ts |
| trpc | symbol | fetchRequestHandler | 5 | packages/server/src/adapters/fetch/fetchRequestHandler.ts | adapters/fetch/index.ts, unstable-core-do-not-import/http/types.ts, adapters/fetch/types.ts |
| trpc | architecture | how tRPC procedures are defined and chained with input and output validation | 5 | packages/server/src/unstable-core-do-not-import/procedure.ts | unstable-core-do-not-import/procedureBuilder.ts, @trpc/server/rpc.ts, unstable-core-do-not-import/middleware.ts |
| messagepack-csharp | semantic | how collections and arrays are serialized | none | src/MessagePack/Formatters/CollectionFormatter.cs | Formatters/PrimitiveObjectFormatter.cs, Formatters/PrimitiveFormatter.cs, Formatters/EnumAsStringFormatter`1.cs |
| messagepack-csharp | semantic | how enums are serialized as integers or strings | none | src/MessagePack/Resolvers/DynamicEnumResolver.cs | Formatters/EnumAsStringFormatter`1.cs, Formatters/StandardClassLibraryFormatter.cs, Resolvers/DynamicEnumAsStringResolver.cs |
| messagepack-csharp | symbol | MessagePackSerializer | 5 | src/MessagePack/MessagePackSerializer.cs | MessagePackSerializerOptions.cs, MessagePackSerializer.NonGeneric.cs, MessagePackSerializer+Typeless.cs |
| messagepack-csharp | symbol | IMessagePackFormatter | 7 | src/MessagePack/Formatters/IMessagePackFormatter`1.cs | Resolvers/CachingFormatterResolver.cs, Formatters/StandardClassLibraryFormatter.cs, Formatters/NilFormatter.cs |
| messagepack-csharp | symbol | CompositeResolver | 4 | src/MessagePack/Resolvers/CompositeResolver.cs | CompositeResolverAttribute.cs, Resolvers/StaticCompositeResolver.cs, Resolvers/StandardResolver.cs |
| ktor | architecture | how request and response pipelines process interceptors | 4 | ktor-client/ktor-client-core/common/src/io/ktor/client/request/HttpRequestPipeline.kt | io/ktor/client/plugins/observer/ResponseObserver.kt, io/ktor/client/plugins/HttpCallValidator.kt, io/ktor/client/statement/HttpResponsePipeline.kt |
| ktor | semantic | how HTTP redirects are followed automatically | 10 | ktor-client/ktor-client-core/common/src/io/ktor/client/plugins/HttpRedirect.kt | io/ktor/client/HttpClientConfig.kt, io/ktor/client/HttpClient.kt, io/ktor/client/statement/HttpStatement.kt |
| ktor | semantic | how server-sent events are received and parsed from a streaming response | 4 | ktor-client/ktor-client-core/common/src/io/ktor/client/plugins/sse/SSE.kt | io/ktor/client/plugins/sse/builders.kt, io/ktor/client/statement/HttpStatement.kt, io/ktor/client/plugins/DefaultResponseValidation.kt |
| ktor | architecture | how the HttpClient plugin installation and configuration pipeline works | 5 | ktor-client/ktor-client-core/common/src/io/ktor/client/plugins/api/ClientPluginBuilder.kt | io/ktor/client/plugins/HttpClientPlugin.kt, io/ktor/client/plugins/api/CreatePluginUtils.kt, io/ktor/client/HttpClientConfig.kt |
| ktor | symbol | HttpClientCall | 5 | ktor-client/ktor-client-core/common/src/io/ktor/client/call/HttpClientCall.kt | io/ktor/client/call/SavedCall.kt, io/ktor/client/call/DelegatedCall.kt, io/ktor/client/HttpClient.kt |
| cats | architecture | how Monad composes dependent effectful computations with flatMap | 5 | core/src/main/scala/cats/Monad.scala | cats/FlatMap.scala, cats/syntax/flatMap.scala, cats/CommutativeFlatMap.scala |
| cats | semantic | how natural transformations map between type constructors | none | core/src/main/scala/cats/arrow/FunctionK.scala | cats/CommutativeFlatMap.scala, cats/CoflatMap.scala, cats/Functor.scala |
| alamofire | semantic | how URL query parameters are encoded from Encodable values | 4 | Source/Features/URLEncodedFormEncoder.swift | Core/ParameterEncoding.swift, Core/Session.swift, Core/ParameterEncoder.swift |
| alamofire | semantic | how download requests save responses to disk | 5 | Source/Core/DownloadRequest.swift | Core/Session.swift, Core/SessionDelegate.swift, Features/Combine.swift |
| serde | semantic | standard library type Deserialize implementations | none | serde_core/src/de/impls.rs | serde/src/private/de.rs, serde_core/src/de/mod.rs, serde_derive/src/de.rs |
| serde | symbol | Visitor | 4 | serde_core/src/de/mod.rs | serde/src/private/de.rs, serde_core/src/de/impls.rs, serde_core/src/de/value.rs |
| zod | semantic | union and discriminated union schema types | 7 | packages/zod/src/v4/core/schemas.ts | v4/core/api.ts, v3/types.ts, v4/classic/schemas.ts |
| zod | semantic | optional and nullable type wrappers | 5 | packages/zod/src/v4/core/schemas.ts | v3/types.ts, v4/mini/schemas.ts, v4/classic/schemas.ts |
| zod | semantic | v3 compatibility error types and ZodError | 8 | packages/zod/src/v3/errors.ts | v4/classic/errors.ts, v4/core/errors.ts, v3/types.ts |
| zod | semantic | z.record and z.map schema builders for key-value types | 7 | packages/zod/src/v4/core/schemas.ts | v3/types.ts, v4/core/api.ts, v4/classic/from-json-schema.ts |
| zod | semantic | enum schema types for literal value sets | 6 | packages/zod/src/v4/core/schemas.ts | v4/classic/from-json-schema.ts, v4/core/json-schema-processors.ts, v4/core/util.ts |
| zod | symbol | ZodObject | 4 | packages/zod/src/v4/classic/schemas.ts | v4/core/schemas.ts, v3/types.ts, v4/mini/schemas.ts |
| nlohmann-json | semantic | JSON serialization to string output | 4 | include/nlohmann/detail/output/serializer.hpp | json.hpp, detail/output/binary_writer.hpp, detail/output/output_adapters.hpp |
| nlohmann-json | architecture | how from_json populates a custom C++ type from JSON | 4 | include/nlohmann/detail/conversions/from_json.hpp | json.hpp, detail/meta/type_traits.hpp, adl_serializer.hpp |
| nlohmann-json | architecture | how to_json serializes a custom C++ type to JSON | 6 | include/nlohmann/detail/conversions/to_json.hpp | json.hpp, detail/meta/type_traits.hpp, detail/json_custom_base_class.hpp |
| nlohmann-json | semantic | iterator implementation for JSON arrays and objects | none | include/nlohmann/detail/iterators/iter_impl.hpp | detail/iterators/internal_iterator.hpp, detail/iterators/json_reverse_iterator.hpp, json.hpp |
| phoenix | architecture | how channels handle incoming messages and replies | none | lib/phoenix/channel.ex | phoenix/socket.ex, phoenix/channel/server.ex, phoenix/debug.ex |
| axum | architecture | how extractors implement FromRequest and FromRequestParts | none | axum/src/extract/mod.rs | middleware/from_extractor.rs, extract/path/mod.rs, extract/query.rs |
| axum | semantic | error handling and how errors are converted to responses | 6 | axum/src/error_handling/mod.rs | lib.rs, extract/path/mod.rs, response/mod.rs |
| axum | semantic | BoxedIntoRoute and type-erased route storage | none | axum/src/routing/route.rs | boxed.rs, routing/mod.rs, routing/method_routing.rs |
| axum | semantic | parsing uploaded binary file parts from HTTP requests | none | axum/src/extract/multipart.rs | extract/ws.rs, extract/query.rs, extract/matched_path.rs |
| axum | semantic | how axum maps Tower middleware layers onto the router | 7 | axum/src/middleware/mod.rs | middleware/from_fn.rs, routing/method_routing.rs, lib.rs |
| axum | symbol | FromRequest | none | axum/src/extract/mod.rs | json.rs, extract/raw_form.rs, extract/multipart.rs |
| vitest | architecture | how vitest initializes worker threads for parallel test execution | none | packages/vitest/src/runtime/workers/init.ts | runtime/workers/vmThreads.ts, node/pools/workers/threadsWorker.ts, runtime/workers/threads.ts |
| vitest | semantic | module mocker for intercepting and replacing module imports at runtime | none | packages/vitest/src/runtime/moduleRunner/moduleMocker.ts | node/reporters/reported-tasks.ts |
| vitest | semantic | task state and task result tracking | none | packages/vitest/src/utils/tasks.ts | node/reporters/reported-tasks.ts, typecheck/typechecker.ts, node/state.ts |
| vitest | architecture | how the StateManager tracks running cancelled and completed test state | 9 | packages/vitest/src/node/state.ts | node/reporters/summary.ts, node/reporters/reported-tasks.ts, node/reporters/dot.ts |
| vitest | semantic | project-level configuration and workspace projects | 9 | packages/vitest/src/node/project.ts | node/projects/resolveProjects.ts, node/core.ts, node/types/config.ts |
| vitest | symbol | Vitest | 6 | packages/vitest/src/node/core.ts | node/plugins/index.ts, node/plugins/workspace.ts, node/plugins/vitestResolver.ts |
| vitest | symbol | StateManager | 6 | packages/vitest/src/node/state.ts | node/core.ts, runtime/workers/base.ts, runtime/utils.ts |
| newtonsoft-json | semantic | JsonConverter abstract class for custom type conversion | 5 | Src/Newtonsoft.Json/JsonConverter.cs | JsonConverterAttribute.cs, Serialization/JsonTypeReflector.cs, Serialization/JsonSerializerInternalReader.cs |
| newtonsoft-json | architecture | how the internal serializer writer maps .NET objects to JSON tokens | 7 | Src/Newtonsoft.Json/Serialization/JsonSerializerInternalWriter.cs | JsonSerializer.cs, Serialization/JsonSerializerProxy.cs, Serialization/JsonSerializerInternalBase.cs |
| newtonsoft-json | semantic | date handling and ISO 8601 parsing in Newtonsoft.Json | 8 | Src/Newtonsoft.Json/Utilities/DateTimeUtils.cs | Bson/BsonReader.cs, Converters/IsoDateTimeConverter.cs, JsonSerializer.cs |
| newtonsoft-json | symbol | JsonConvert | 4 | Src/Newtonsoft.Json/JsonConvert.cs | JsonConverter.cs, Converters/XmlNodeConverter.cs, Linq/JValue.cs |
| dapper | architecture | how Dapper maps columns to object properties by name | 4 | Dapper/SqlMapper.cs | SqlMapper.DapperRow.Descriptor.cs, DefaultTypeMap.cs, SqlMapper.DapperTable.cs |
| dapper | symbol | SqlMapper | none | Dapper/SqlMapper.cs | SqlMapper.DontMap.cs, SqlMapper.IParameterLookup.cs, SqlMapper.ICustomQueryParameter.cs |
| exposed | semantic | Column definition and column types in Exposed | none | exposed-core/src/main/kotlin/org/jetbrains/exposed/v1/core/Column.kt | org/jetbrains/exposed/v1/core/Table.kt, org/jetbrains/exposed/v1/core/vendors/DatabaseDialect.kt, org/jetbrains/exposed/v1/core/statements/api/ExposedDatabaseMetadata.kt |
| exposed | semantic | update and delete statement builders | 6 | exposed-core/src/main/kotlin/org/jetbrains/exposed/v1/core/statements/UpdateStatement.kt | org/jetbrains/exposed/v1/core/statements/MergeStatement.kt, org/jetbrains/exposed/v1/core/statements/StatementBuilder.kt, org/jetbrains/exposed/v1/core/statements/Statement.kt |
| exposed | semantic | SchemaUtils for creating and dropping database tables | none | exposed-jdbc/src/main/kotlin/org/jetbrains/exposed/v1/jdbc/SchemaUtils.kt | org/jetbrains/exposed/v1/core/vendors/DatabaseDialect.kt, org/jetbrains/exposed/v1/core/vendors/SchemaMetadata.kt, org/jetbrains/exposed/v1/core/SchemaUtilityApi.kt |
| exposed | architecture | how expressions and SQL operators are composed in Exposed | none | exposed-core/src/main/kotlin/org/jetbrains/exposed/v1/core/Expression.kt | org/jetbrains/exposed/v1/core/Function.kt, org/jetbrains/exposed/v1/core/Op.kt, org/jetbrains/exposed/v1/core/vendors/PostgreSQL.kt |
| exposed | symbol | Transaction | 9 | exposed-core/src/main/kotlin/org/jetbrains/exposed/v1/core/Transaction.kt | org/jetbrains/exposed/v1/core/transactions/TransactionInterface.kt, org/jetbrains/exposed/v1/core/transactions/Transactions.kt, org/jetbrains/exposed/v1/core/transactions/suspend/TransactionContextElement.kt |
| circe | architecture | how circe parses a JSON string into a Json value | none | modules/core/shared/src/main/scala/io/circe/Parser.scala | io/circe/Json.scala, io/circe/JsonObject.scala, io/circe/JsonNumber.scala |
| http4s | semantic | Headers and individual Header types | 7 | core/shared/src/main/scala/org/http4s/Headers.scala | org/http4s/headers/HeaderCompanion.scala, org/http4s/Header.scala, org/http4s/headers/Access-Control-Allow-Headers.scala |
| http4s | semantic | Uri parsing and construction | 9 | core/shared/src/main/scala/org/http4s/Uri.scala | org/http4s/internal/parsing/AuthRules.scala, org/http4s/internal/parsing/Rfc3986.scala, org/http4s/internal/parsing/Rfc2616.scala |
| http4s | architecture | how Kleisli and OptionT power the Http and HttpRoutes algebra | 5 | core/shared/src/main/scala/org/http4s/Http.scala | org/http4s/syntax/KleisliSyntax.scala, org/http4s/HttpRoutes.scala, org/http4s/AuthedRoutes.scala |
| vapor | architecture | how Application configures and boots a Vapor server | 4 | Sources/Vapor/Application.swift | HTTP/Server/Application+HTTP+Server.swift, HTTP/Server/HTTPServer.swift, Server/Application+Servers.swift |
| vapor | architecture | how routes are registered on the RoutesBuilder | 6 | Sources/Vapor/Routing/RoutesBuilder+Method.swift | Routing/RoutesBuilder+Group.swift, Routing/RoutesBuilder+Middleware.swift, Routing/RouteCollection.swift |
| vapor | semantic | Content protocol for encoding and decoding request and response bodies | 7 | Sources/Vapor/Content/Content.swift | Response/Response.swift, Concurrency/ResponseCodable+Concurrency.swift, Request/Request.swift |
| vapor | architecture | how Vapor Application stores and retrieves services via Storage | 4 | Sources/Vapor/Utilities/Storage.swift | Services/App+Service.swift, Services/Service.swift, Responder/Application+Responder.swift |
| vapor | semantic | WebSocket upgrade and handler registration in Vapor | 4 | Sources/Vapor/Routing/RoutesBuilder+WebSocket.swift | HTTP/Server/HTTPServerUpgradeHandler.swift, Routing/Request+WebSocket.swift, Concurrency/WebSocket+Concurrency.swift |
| vapor | semantic | Sessions and session driver for server-side session storage | 8 | Sources/Vapor/Sessions/Session.swift | Concurrency/AsyncSessionDriver.swift, Sessions/SessionDriver.swift, Sessions/SessionsMiddleware.swift |
| vapor | semantic | HTTP status codes and media types in Vapor | 9 | Sources/Vapor/HTTP/HTTPStatus.swift | HTTP/Headers/HTTPMediaType.swift, Utilities/VaporSendableMetadataType.swift, HTTP/Headers/HTTPHeaders.swift |
| vapor | symbol | Application | none | Sources/Vapor/Application.swift | HTTP/Application+HTTP.swift, Passwords/Application+Passwords.swift, Responder/Application+Responder.swift |
| snapkit | semantic | how offset and inset modifiers adjust the constant value of a constraint | 5 | Sources/ConstraintMakerEditable.swift | ConstraintOffsetTarget.swift, ConstraintInsetTarget.swift, Constraint.swift |
| snapkit | architecture | how DSL protocols define layout anchor properties like left, top, edges, and center for views and guides | 4 | Sources/ConstraintDSL.swift | ConstraintLayoutGuideDSL.swift, Constraint.swift, ConstraintAttributes.swift |
| plug | semantic | URL-encoded form body parser | 8 | lib/plug/parsers/urlencoded.ex | parsers/multipart.ex, parsers.ex, conn/query.ex |
| ecto | semantic | preload for loading associations eagerly | 5 | lib/ecto/query.ex | query/builder/preload.ex, repo/preloader.ex, repo.ex |
| abseil-cpp | semantic | absl logging macros ABSL_LOG and ABSL_CHECK | 9 | absl/log/absl_log.h | log/internal/test_helpers.h, log/flags.cc, log/internal/check_op.cc |
| abseil-cpp | architecture | absl::Hash and the Abseil hashing framework | 7 | absl/hash/hash.h | hash/internal/spy_hash_state.h, hash/internal/hash.h, hash/internal/city.cc |
| fmtlib | semantic | format_error and error handling for invalid format strings | 5 | include/fmt/base.h | format-inl.h, os.h, format.h |
| curl | architecture | how curl resolves and connects to a remote host | none | lib/connect.c | http.c, cfilters.h, url.c |
| curl | semantic | how a new easy handle is initialized with default settings | 9 | lib/url.c | http2.c, vquic/curl_ngtcp2.c, vtls/schannel.c |
| curl | semantic | how curl checks if HTTP If-Modified-Since condition is met | 9 | lib/transfer.c | http.c, http_proxy.c, http2.c |
| curl | architecture | connection filter chain setup for proxies and TLS | none | lib/connect.c | url.c, vquic/vquic-tls.h, ftp.c |
| curl | architecture | how SSL is configured on a connection | 6 | lib/url.c | vtls/vtls_int.h, vtls/vtls.c, vtls/openssl.c |
| curl | semantic | freeing all resources when closing an easy handle | 5 | lib/url.c | multi.c, easy.c, vtls/openssl.c |
| redis | semantic | how Redis implements the SET command with options like NX, EX, PX | none | src/t_string.c | module.c, redis-trib.rb, t_hash.c |
| redis | architecture | server startup initialization and configuration loading | 6 | src/server.c | rdb.c, module.c, acl.c |
| redis | architecture | how Redis cluster handles slot assignment and routing | 5 | src/cluster.c | redis-cli.c, cluster_slot_stats.c, cluster_legacy.c |
| libuv | semantic | file system operations like read write open stat | 6 | src/unix/fs.c | win/fs.c, win/pipe.c, unix/linux.c |
| libuv | semantic | resolving hostnames asynchronously using the thread pool | none | src/unix/getaddrinfo.c | win/pipe.c, win/thread.c, unix/thread.c |
| libuv | semantic | file system event watching with inotify or kqueue | 7 | src/unix/fsevents.c | unix/linux.c, unix/async.c, unix/kqueue.c |
| libuv | semantic | idle and prepare handle callbacks before blocking | 4 | src/unix/core.c | unix/stream.c, win/core.c, win/stream.c |
| libuv | semantic | libuv handle reference counting and close | none | src/uv-common.c | unix/core.c, win/pipe.c, win/handle.c |
| libuv | symbol | IDNA internationalized domain name encoding | 4 | src/idna.c | idna.h, win/pipe.c, win/winapi.h |
| bats-core | semantic | how bats formats test result output | 4 | lib/bats-core/formatter.bash | bats-core/test_functions.bash, bats-core/preprocessing.bash, bats-core/common.bash |
| aeson | architecture | how JSON encoding produces Encoding without materializing a Value | 4 | src/Data/Aeson/Encoding.hs | Encoding/Internal.hs, Types/ToJSON.hs, TH.hs |
| aeson | semantic | how Key type is used as object field identifier | 5 | src/Data/Aeson/KeyMap.hs | TH.hs, Types/Internal.hs, Types/FromJSON.hs |
| telescope.nvim | architecture | how telescope actions map keys to picker operations | 4 | lua/telescope/actions/init.lua | mappings.lua, init.lua, actions/utils.lua |
| telescope.nvim | architecture | how async_job runs an external command and streams results | 4 | lua/telescope/async_job.lua | finders/async_job_finder.lua, finders.lua, finders/async_oneshot_finder.lua |
| lazy.nvim | architecture | how lazy.nvim loads a plugin on demand when its trigger fires | none | lua/lazy/core/loader.lua | init.lua, example.lua, view/render.lua |
| lazy.nvim | semantic | how the lockfile pins plugin commits for reproducible installs | 5 | lua/lazy/manage/lock.lua | manage/init.lua, manage/task/git.lua, view/render.lua |
| lazy.nvim | semantic | how text sections are rendered in the lazy view | 9 | lua/lazy/view/sections.lua | view/render.lua, view/init.lua, view/text.lua |
| lazy.nvim | semantic | how lazy util functions provide error handling and module loading | 7 | lua/lazy/core/util.lua | init.lua, pkg/lazy.lua, core/loader.lua |
| zig | semantic | how std.testing.expect and expectEqual assert conditions in tests | none | lib/std/testing.zig | crypto/timing_safe.zig, http/test.zig, crypto/codecs/asn1/der/Decoder.zig |
| bash-it | semantic | battery level detection for shell prompt | 7 | lib/battery.bash | themes/powerline/powerline.base.bash, themes/gitline/powerline.base.bash, themes/powerturk/powerturk.theme.bash |
| bash-it | semantic | color definitions and terminal color support | none | lib/colors.bash | themes/dulcie/dulcie.theme.bash, themes/powerturk/powerturk.theme.bash, themes/emperor/emperor.theme.bash |
| bash-it | semantic | how tab completion scripts are sourced and activated | none | lib/completion.bash | completion/available/aliases.completion.bash, completion/available/lerna.completion.bash, plugins/available/osx.plugin.bash |
| bash-it | symbol | node version manager nvm integration | 4 | plugins/available/node.plugin.bash | themes/base.theme.bash, plugins/available/nvm.plugin.bash, completion/available/nvm.completion.bash |
| bash-it | semantic | bash-it utility functions for string manipulation | none | lib/utilities.bash | install.sh, lib/preexec.bash, completion/available/bash-it.completion.bash |
| bash-it | semantic | bash-it main entry point and initialization | 6 | bash_it.sh | lib/helpers.bash, completion/available/bash-it.completion.bash, aliases/available/bash-it.aliases.bash |
| pandoc | architecture | how the PandocMonad typeclass abstracts IO for readers and writers | none | Class.hs | Writers/BBCode.hs, Class/PandocIO.hs, Class/PandocMonad.hs |
| pandoc | semantic | how pandoc reads a DocBook XML document | 8 | Readers/DocBook.hs | Writers/DocBook.hs, Writers/XML.hs, Readers/Docx/Parse.hs |
| pandoc | semantic | how pandoc options control output format and extensions | 9 | Options.hs | Format.hs, App/OutputSettings.hs, Extensions.hs |
| pandoc | semantic | how pandoc parses table structures in documents | none | Parsing/GridTable.hs | Readers/Jira.hs, Readers/Muse.hs, Readers/Haddock.hs |
| pandoc | semantic | how pandoc fetches and embeds media into self-contained output | 4 | SelfContained.hs | Writers/Docx/OpenXML.hs, MediaBag.hs, App.hs |
| pandoc | semantic | how pandoc handles TeX math in documents | none | TeX.hs | Writers/Math.hs, Writers/LaTeX.hs, Parsing/Math.hs |
| pandoc | architecture | how pandoc parses generic parsing utilities for readers | none | Parsing/General.hs | Readers/Textile.hs, Readers/Txt2Tags.hs, Readers/Org/Blocks.hs |
| pandoc | architecture | how pandoc generates PDF output via LaTeX or other backends | 4 | PDF.hs | Writers/LaTeX.hs, App.hs, Readers/LaTeX.hs |
| xmonad | architecture | how xmonad applies layout algorithms to arrange windows on screen | 4 | Layout.hs | Operations.hs, Core.hs, Config.hs |
| xmonad | semantic | how xmonad uses withDisplay to get the X11 Display handle | none | Core.hs | Operations.hs |
| zls | architecture | how zls traverses the Zig AST to resolve symbol scopes | none | ast.zig | analysis.zig, DocumentScope.zig, features/document_symbol.zig |
| zls | semantic | how zls translates C headers for Zig interop | 5 | translate_c.zig | Server.zig, tools/config_gen.zig, build_runner/check.zig |
| zig-clap | semantic | how zig-clap iterates over OS process arguments | 7 | clap/args.zig | clap/streaming.zig, example/streaming-clap.zig, example/subcommands.zig |
| zig-clap | semantic | how zig-clap built-in parsers convert strings to typed values | 5 | clap/parsers.zig | clap.zig, example/simple-ex.zig, clap/streaming.zig |
| zig-clap | semantic | how zig-clap prints usage summary for a command | 4 | clap.zig | example/usage.zig, example/subcommands.zig, example/help.zig |
