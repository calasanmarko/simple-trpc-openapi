import type { ReferenceObject } from "openapi3-ts/oas31";
import { z } from "zod";

export const getZodType = (type: z.ZodType | undefined) => {
    return (type?._def as { typeName: z.ZodFirstPartyTypeKind })?.typeName;
};

export const isZodType = <T extends z.ZodType & { _def: { typeName: z.ZodFirstPartyTypeKind } }>(
    type: z.ZodType | undefined,
    typeName: T["_def"]["typeName"]
): type is T => {
    return getZodType(type) === typeName;
};

export const isReferenceObject = (obj: object): obj is ReferenceObject => {
    return "$ref" in obj;
};

export const processProcedureSchema = <T extends z.ZodType>(type: T | undefined) => {
    switch (getZodType(type)) {
        case z.ZodFirstPartyTypeKind.ZodVoid:
            return undefined;
        default:
            return type;
    }
};

export const unwrap = (v: z.ZodTypeAny): z.ZodTypeAny => {
    if (
        isZodType<z.ZodOptional<never>>(v, z.ZodFirstPartyTypeKind.ZodOptional) ||
        isZodType<z.ZodNullable<never>>(v, z.ZodFirstPartyTypeKind.ZodNullable)
    ) {
        return unwrap(v.unwrap());
    }

    if (isZodType<z.ZodEffects<never, never>>(v, z.ZodFirstPartyTypeKind.ZodEffects)) {
        return unwrap(v._def.schema);
    }

    return v;
};
