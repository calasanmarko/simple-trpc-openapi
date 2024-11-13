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
import type { OpenAPIObject } from "openapi3-ts/oas31";

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
        inputs: (z.ZodTypeAny | undefined)[];
        output: z.ZodTypeAny | undefined;
    };
};

const processZodType = (type: z.ZodTypeAny | undefined) => {
    switch (type?._def.typeName) {
        case z.ZodFirstPartyTypeKind.ZodVoid:
            return undefined;
        default:
            return type;
    }
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
        const input = processZodType(procedure._def.inputs.at(0));
        const output = processZodType(procedure._def.output);

        const inputOpenApi = input?._def.zodOpenApi?.openapi as z.ZodTypeDef["openapi"] | undefined;
        const outputOpenApi = output?._def.zodOpenApi?.openapi as z.ZodTypeDef["openapi"] | undefined;

        const inputContentType = inputOpenApi?.contentMediaType ?? "application/json";
        if (inputContentType === "multipart/form-data" && openapiMeta.method !== "post") {
            throw new Error(`${name}: Multipart form data is only supported for POST requests`);
        }

        if (input && inputOpenApi?.title) {
            schemas[input._def.zodOpenApi.openapi.title] = input;
        }

        if (output && outputOpenApi?.title) {
            schemas[output._def.zodOpenApi.openapi.title] = output;
        }

        const requestParams =
            openapiMeta.method === "get" && input
                ? ({
                      query: input,
                  } satisfies ZodOpenApiParameters)
                : undefined;

        const requestBody =
            openapiMeta.method !== "get"
                ? ({
                      content: {
                          [inputOpenApi?.contentMediaType ?? "application/json"]: {
                              ...(input ? { schema: input } : {}),
                          },
                      },
                  } satisfies ZodOpenApiRequestBodyObject)
                : undefined;

        const responses = output
            ? ({
                  default: {
                      description: "Successful response",
                      content: {
                          "application/json": {
                              schema: output,
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
        openapi: "3.0.3",
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
    const unwrap = (v: z.ZodTypeAny) => {
        if (
            v._def.typeName === z.ZodFirstPartyTypeKind.ZodOptional ||
            v._def.typeName === z.ZodFirstPartyTypeKind.ZodNullable
        ) {
            return unwrap((v as z.ZodOptional<never> | z.ZodNullable<never>).unwrap());
        }

        if (v._def.typeName === z.ZodFirstPartyTypeKind.ZodEffects) {
            return unwrap((v as z.ZodEffects<never, never>)._def.schema);
        }

        return v;
    };

    const coerceFormValue = (key: string | undefined, value: unknown, schema: z.ZodTypeAny) => {
        if (schema._def.typeName === z.ZodFirstPartyTypeKind.ZodNumber) {
            return Number(value);
        }

        if (schema._def.typeName === z.ZodFirstPartyTypeKind.ZodBoolean) {
            return value === "true";
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
