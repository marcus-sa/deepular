import { HtmlResponse, HttpRequest, httpWorkflow } from '@deepkit/http';
import { readFile } from 'node:fs/promises';
import {
  provideServerRendering,
  renderApplication,
  ɵSERVER_CONTEXT as SERVER_CONTEXT,
} from '@angular/platform-server';
import { bootstrapApplication } from '@angular/platform-browser';
import {
  APP_INITIALIZER,
  ApplicationConfig,
  ApplicationRef, mergeApplicationConfig,
  Provider,
  Signal,
  signal,
  TransferState,
} from '@angular/core';
import { eventDispatcher } from '@deepkit/event';
import { rpcClass, RpcKernel } from '@deepkit/rpc';
import { ReflectionClass, resolveRuntimeType, SerializedTypes, serializeType } from '@deepkit/type';
import { BSONSerializer } from '@deepkit/bson';
import {
  CORE_CONFIG,
  getNgKitSerializer,
  getProviderNameForType,
  makeSerializableStateKey, makeSerializedClassTypeStateKey,
  ServerControllerTypeName, SignalControllerMethod, SignalControllerTypeName,
  unwrapType,
} from '@ngkit/core';
import { catchError, firstValueFrom, from, Observable, of, tap } from 'rxjs';
import { toSignal } from '@angular/core/rxjs-interop';

import { ServerConfig } from './config';
import { InjectorContext } from '@deepkit/injector';

export class SsrListener {
  readonly ngControllerProviders = new Set<Provider>();
  readonly rpcControllerSerializedClassTypes = new Map<
    string,
    SerializedTypes
  >();
  readonly appConfig: ApplicationConfig;

  constructor(
    private readonly config: ServerConfig,
    private readonly rpcKernel: RpcKernel,
    private readonly injector: InjectorContext
  ) {
    this.rpcKernel.controllers.forEach(({ module, controller }) => {
      const controllerType = resolveRuntimeType(controller);
      const controllerReflectionClass = ReflectionClass.from(controllerType);

      if (!module.injector) {
        throw new Error(`Missing injector for module ${module.constructor.name}`);
      }
      // FIXME
      // ServiceNotFoundError: Service 'AppController' in RootAppModule not found. Make sure it is provided.
      const instance = this.injector.get(controllerType, module);

      const controllerMetadata = rpcClass._fetch(controller);
      if (!controllerMetadata) {
        throw new Error('Missing controller metadata');
      }

      const controllerName = controllerMetadata.getPath();
      const controllerReflectionMethods = controllerReflectionClass.getMethods();
      const controllerMethodNames = controllerReflectionMethods.map(
        method => method.name,
      );

      this.rpcControllerSerializedClassTypes.set(
        controllerName,
        serializeType(controllerType),
      );

      const serializers = new Map<string, BSONSerializer>(
        controllerReflectionClass.getMethods().map(method => {
          const returnType = unwrapType(method.getReturnType());
          const serialize = getNgKitSerializer(returnType);
          return [method.name, serialize];
        }),
      );

      const serverControllerProviderName = getProviderNameForType(
        ServerControllerTypeName,
        controllerName,
      );

      this.ngControllerProviders.add({
        provide: serverControllerProviderName,
        deps: [TransferState],
        useFactory(transferState: TransferState) {
          return new Proxy(instance, {
            get: (target, propertyName: string) => {
              if (!controllerMethodNames.includes(propertyName)) return;

              const serialize = serializers.get(propertyName)!;

              // TODO: only @rpc.loader() methods should be callable on the server
              return async (...args: []): Promise<unknown> => {
                // @ts-ignore
                let result = await target[propertyName](...args);

                const transferStateKey = makeSerializableStateKey(
                  controllerName,
                  propertyName,
                  args,
                );

                if (result instanceof Observable) {
                  result = await firstValueFrom(result);
                }

                transferState.set(transferStateKey, serialize({ data: result }));

                return result;
              };
            },
          });
        },
      });

      const signalControllerProviderName = getProviderNameForType(
        SignalControllerTypeName,
        controllerName,
      );

      this.ngControllerProviders.add({
        provide: signalControllerProviderName,
        deps: [TransferState],
        useFactory(transferState: TransferState) {
          return new Proxy(instance, {
            get: (target, propertyName: string) => {
              if (!controllerMethodNames.includes(propertyName)) return;

              const serialize = serializers.get(propertyName)!;

              // TODO: only @rpc.loader() methods should be callable on the server
              return (
                ...args: []
              ): SignalControllerMethod<unknown, unknown[]> => {
                // @ts-ignore
                let result = target[propertyName](...args);

                const transferStateKey = makeSerializableStateKey(
                  controllerName,
                  propertyName,
                  args,
                );

                const transferResult = (data: unknown) => {
                  transferState.set(transferStateKey, serialize({ data }));
                };

                const isPromise = result instanceof Promise;
                const isObservable = result instanceof Observable;

                const error = signal<Error | null>(null);

                let value: Signal<unknown> | undefined;

                if (!isPromise && !isObservable) {
                  transferResult(result);
                  value = signal(result);
                }

                if (isPromise) {
                  result = from(result);
                }

                if (!value) {
                  result = result.pipe(
                    tap(transferResult),
                    catchError(err => {
                      error.set(err);
                      return of(null);
                    }),
                  );
                  value = toSignal(result, { requireSync: true });
                }

                return {
                  refetch: (): never => {
                    throw new Error('Cannot be used on the server');
                  },
                  update: (): never => {
                    throw new Error('Cannot be used on the server');
                  },
                  loading: signal(false),
                  error,
                  value,
                };
              };
            },
          });
        },
      });
    })

    const ngAppInit: Provider = {
      provide: APP_INITIALIZER,
      deps: [TransferState],
      multi: true,
      useFactory: (transferState: TransferState) => {
        return () => {
          this.rpcControllerSerializedClassTypes.forEach(
            (serializedClassType, name) => {
              transferState.set(
                makeSerializedClassTypeStateKey(name),
                serializedClassType,
              );
            },
          );
        };
      },
    };

    const serverConfig: ApplicationConfig = {
      providers: [
        provideServerRendering(),
        ngAppInit,
        ...this.ngControllerProviders,
      ],
    };

    this.appConfig = this.config.app ? mergeApplicationConfig(
      CORE_CONFIG,
      serverConfig,
      this.config.app,
    ) : mergeApplicationConfig(CORE_CONFIG, serverConfig);
  }

  async bootstrap(): Promise<ApplicationRef> {
    return bootstrapApplication(this.config.rootComponent, this.appConfig);
  }

  async render(request: HttpRequest) {
    const document = this.config.documentPath
      ? await readFile(this.config.documentPath, 'utf8')
      : this.config.document;

    const html = await renderApplication(() => this.bootstrap(), {
      url: request.getUrl(),
      document,
      platformProviders: [
        {
          provide: SERVER_CONTEXT,
          useValue: 'deepkit',
        },
      ],
    });

    return new HtmlResponse(html);
  }

  @eventDispatcher.listen(httpWorkflow.onRoute, 101)
  async onRoute(
    event: typeof httpWorkflow.onRoute.event,
  ): Promise<HtmlResponse | undefined> {
    if (event.response.headersSent) return;
    if (event.route) return;
    return await this.render(event.request);
  }
}
