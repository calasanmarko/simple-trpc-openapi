import type { AnyTRPCRouter, AnyTRPCProcedure } from "@trpc/server";
import { z } from "zod";
import {
    type ZodOpenApiPathsObject,
    type ZodOpenApiParameters,
    type ZodOpenApiRequestBodyObject,
    type ZodOpenApiResponsesObject,
    createDocument,
    type ZodOpenApiObject,
} from "zod-openapi";
import { fetchRequestHandler, type FetchHandlerRequestOptions } from "@trpc/server/adapters/fetch";
import type { EncodingObject, OpenAPIObject, ParameterObject, SchemaObject } from "openapi3-ts/oas31";
import { isReferenceObject, isZodType, processProcedureSchema, unwrap } from "./utility.js";

export type TRPCOpenApiMethod = "get" | "post" | "put" | "delete";

export type TRPCOpenApiMeta = {
    openapi?: {
        path: string;
        method: TRPCOpenApiMethod;
    };
};

export type SimpleTRPCOpenApiDoc = {
    spec: OpenAPIObject;
    openApiToTRPCPaths: Record<string, Partial<Record<TRPCOpenApiMethod, string>>>;
};

type TRPCProcedureWithInput = AnyTRPCProcedure & {
    _def: AnyTRPCProcedure["_def"] & {
        meta?: TRPCOpenApiMeta;
        inputs: (z.ZodType | undefined)[];
        output: z.ZodType | undefined;
    };
};

export const createTRPCOpenApiDoc = (opts: {
    router: AnyTRPCRouter;
    url: string;
    info: ZodOpenApiObject["info"];
}): SimpleTRPCOpenApiDoc => {
    const paths: ZodOpenApiPathsObject = {};
    const schemas: Record<string, z.ZodTypeAny> = {};
    const openApiToTRPCPaths: Record<string, Partial<Record<TRPCOpenApiMethod, string>>> = {};

    for (const [name, rawProcedure] of Object.entries(opts.router._def.procedures)) {
        const procedure = rawProcedure as unknown as TRPCProcedureWithInput;
        const openapiMeta = procedure._def.meta?.openapi;
        if (!openapiMeta) {
            continue;
        }
        const input = processProcedureSchema(procedure._def.inputs.at(0));
        const output = processProcedureSchema(procedure._def.output);

        const inputOpenApi = input?._def.zodOpenApi?.openapi;
        const outputOpenApi = output?._def.zodOpenApi?.openapi;

        if (input && inputOpenApi?.title) {
            schemas[inputOpenApi.title] = input;
        }

        if (output && outputOpenApi?.title) {
            schemas[outputOpenApi.title] = output;
        }

        const requestParams =
            openapiMeta.method === "get" && input
                ? ({
                      query: input,
                  } satisfies ZodOpenApiParameters)
                : undefined;

        const requestBody: ZodOpenApiRequestBodyObject | undefined = (() => {
            if (openapiMeta.method === "get") {
                return undefined;
            }

            if (!input) {
                return {
                    content: { "application/json": {} },
                };
            }

            const inputContentType = inputOpenApi?.contentMediaType ?? "application/json";
            const unwrappedInput = unwrap(input);
            const encoding =
                isZodType<z.ZodObject<never>>(unwrappedInput, z.ZodFirstPartyTypeKind.ZodObject) &&
                inputContentType === "multipart/form-data"
                    ? Object.entries(unwrappedInput.shape).reduce((acc, [key, value]) => {
                          const unwrappedSchema = unwrap(value as z.ZodType);
                          if (isZodType<z.ZodArray<never, never>>(unwrappedSchema, z.ZodFirstPartyTypeKind.ZodArray)) {
                              acc[key] = {
                                  explode: true,
                              };
                          }
                          return acc;
                      }, {} as EncodingObject)
                    : {};

            return {
                content: {
                    [inputContentType]: {
                        schema: input,
                        encoding,
                    },
                },
            };
        })();

        const responses = output
            ? ({
                  default: {
                      description: "Successful response",
                      content: {
                          "application/json": {
                              schema: z.object({
                                  result: z.object({
                                      data: output,
                                  }),
                              }),
                          },
                      },
                  },
              } satisfies ZodOpenApiResponsesObject)
            : {};

        const url = new URL(opts.url);
        paths[openapiMeta.path] ||= {};
        paths[openapiMeta.path][openapiMeta.method] = {
            ...(requestBody ? { requestBody } : {}),
            ...(requestParams ? { requestParams } : {}),
            responses,
        };

        const path = `${url.pathname}${openapiMeta.path}`;
        openApiToTRPCPaths[path] ||= {};
        openApiToTRPCPaths[path][openapiMeta.method] = name;
    }

    const spec = createDocument({
        openapi: "3.1.0",
        info: opts.info,
        servers: [{ url: opts.url }],
        paths,
        components: {
            schemas,
            securitySchemes: {
                bearerAuth: {
                    type: "http",
                    scheme: "bearer",
                },
            },
        },
        security: [
            {
                bearerAuth: [],
            },
        ],
    });

    for (const path in spec.paths) {
        const sanitizeSchema = (schema: SchemaObject, parameter?: ParameterObject) => {
            if (Array.isArray(schema.type) && schema.type.includes("null")) {
                const filteredTypes = schema.type.filter((type) => type !== "null");
                schema.type = filteredTypes.length === 1 ? filteredTypes[0] : filteredTypes;

                if (parameter) {
                    parameter.required = false;
                }
            }
        };

        const pathSpec = spec.paths[path];

        const getParameters = pathSpec.get?.parameters;
        if (getParameters) {
            for (const parameterKey in getParameters) {
                const parameter = getParameters[parameterKey];
                if (!isReferenceObject(parameter) && parameter.schema && !isReferenceObject(parameter.schema)) {
                    sanitizeSchema(parameter.schema, parameter);
                }
            }
        }

        const requestBody = pathSpec.post?.requestBody;
        if (requestBody && !isReferenceObject(requestBody) && requestBody.content) {
            const multipartSchema = requestBody.content["multipart/form-data"]?.schema;
            if (multipartSchema && !isReferenceObject(multipartSchema) && multipartSchema.properties) {
                for (const propertyKey in multipartSchema.properties) {
                    const property = multipartSchema.properties[propertyKey];
                    if (!isReferenceObject(property)) {
                        sanitizeSchema(property);
                    }
                }
            }
        }
    }

    return {
        spec,
        openApiToTRPCPaths,
    };
};

export const preprocessFormData = <TShape extends z.ZodRawShape>(
    formData: FormData | URLSearchParams,
    schema: z.ZodObject<TShape>
) => {
    const data: Record<string, unknown> = {};

    const coerceFormValue = (key: string | undefined, value: unknown, schema: z.ZodTypeAny) => {
        if (typeof value === "string") {
            try {
                value = JSON.parse(value);
            } catch {}
        }

        if (schema._def.typeName === z.ZodFirstPartyTypeKind.ZodNumber) {
            return Number(value);
        }

        if (schema._def.typeName === z.ZodFirstPartyTypeKind.ZodBoolean) {
            return value === "true" || value === true;
        }

        if (schema._def.typeName === z.ZodFirstPartyTypeKind.ZodArray) {
            if (key === undefined) {
                throw new Error("Nested arrays are not supported");
            }

            if (data[key] !== undefined && !Array.isArray(data[key])) {
                throw new Error(`Expected array for key ${key}`);
            }

            data[key] ||= [];
            (data[key] as unknown[]).push(coerceFormValue(key, value, unwrap(schema._def.type)));

            return data[key];
        }

        return value;
    };

    formData.forEach((value, key) => {
        if (!(key in schema.shape)) {
            return;
        }

        const zodKey = unwrap(schema.shape[key]);
        data[key] = coerceFormValue(key, value, zodKey);
    });

    return data;
};

export const simpleTRPCOpenApiRequestHandler = async <TRouter extends AnyTRPCRouter>(
    doc: SimpleTRPCOpenApiDoc,
    opts: FetchHandlerRequestOptions<TRouter>
): Promise<Response> => {
    const url = new URL(opts.req.url);
    const method = opts.req.method.toLowerCase() as TRPCOpenApiMethod;

    const trpcPath = doc.openApiToTRPCPaths[url.pathname]?.[method];
    if (!trpcPath) {
        return new Response("Not found", { status: 404 });
    }

    const input = opts.router._def.procedures[trpcPath]._def.inputs.at(0);
    if (input) {
        const parsedSearchParams = preprocessFormData(url.searchParams, input);
        url.search = `?input=${JSON.stringify(parsedSearchParams)}`;
    }

    url.pathname = `${opts.endpoint}/${trpcPath}`;

    const urlReq = new Request(url, opts.req);
    const req = new Request(urlReq, {
        method: method === "get" ? "get" : "post",
    });
    return fetchRequestHandler({ ...opts, req });
};
