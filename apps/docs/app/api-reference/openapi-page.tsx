"use client"

import type { ChangeEvent, ComponentProps } from "react"
import { useEffect, useRef } from "react"
import { Custom } from "fumadocs-openapi/playground/client"
import { createOpenAPIPage } from "fumadocs-openapi/ui"
import type { CreateOpenAPIPageOptions } from "fumadocs-openapi/ui"

const configuredApiUrl = process.env.NEXT_PUBLIC_API_URL
const apiServer =
  configuredApiUrl === undefined || configuredApiUrl.length === 0
    ? undefined
    : new URL(configuredApiUrl).toString()
type ParameterRenderer = NonNullable<
  NonNullable<CreateOpenAPIPageOptions["playground"]>["renderParameterField"]
>
type ParameterFieldName = Parameters<ParameterRenderer>[0]
type Parameter = Parameters<ParameterRenderer>[1]

interface ParameterFieldProps {
  readonly fieldName: ParameterFieldName
  readonly parameter: Parameter
}

const ParameterField = ({ fieldName, parameter }: ParameterFieldProps) => {
  const defaultValue = parameter.in === "path" ? "" : undefined
  const { value, setValue } = Custom.useController(fieldName, { defaultValue })
  const inputId = fieldName.map((part) => String(part)).join("-")
  const clearGeneratedSample = useRef(value === "string")
  const inputValue = clearGeneratedSample.current
    ? ""
    : typeof value === "string"
      ? value
      : ""

  useEffect(() => {
    if (!clearGeneratedSample.current) return
    clearGeneratedSample.current = false
    setValue("")
  }, [setValue])

  return (
    <fieldset className="kronik-openapi-fieldset">
      <label className="kronik-openapi-label" htmlFor={inputId}>
        <span>{parameter.name}</span>
        <code>string</code>
        {parameter.required === true ? <span aria-hidden="true">*</span> : null}
      </label>
      <input
        id={inputId}
        className="kronik-openapi-input"
        placeholder="string"
        required={parameter.required === true}
        value={inputValue}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          const rawValue = event.target === null ? undefined : Reflect.get(event.target, "value")
          const nextValue = typeof rawValue === "string" ? rawValue : ""
          setValue(nextValue.length === 0 && parameter.required !== true ? undefined : nextValue)
        }}
      />
    </fieldset>
  )
}

const renderParameterField: ParameterRenderer = (fieldName, parameter) => (
  <ParameterField fieldName={fieldName} parameter={parameter} />
)

const GeneratedOpenAPIPage = createOpenAPIPage({
  showResponseSchema: false,
  playground: {
    enabled: apiServer !== undefined,
    fetchOptions: { requestTimeout: 30 },
    renderParameterField,
  },
})
type OpenAPIPageProps = ComponentProps<typeof GeneratedOpenAPIPage>

/** Render an OpenAPI operation against the deployed API when its public URL is configured. */
export default function OpenAPIPage(props: OpenAPIPageProps) {
  if (apiServer === undefined || !("payload" in props)) {
    return <GeneratedOpenAPIPage {...props} />
  }

  return (
    <GeneratedOpenAPIPage
      {...props}
      payload={{
        ...props.payload,
        bundled: {
          ...props.payload.bundled,
          servers: [{ url: apiServer }],
        },
      }}
    />
  )
}
