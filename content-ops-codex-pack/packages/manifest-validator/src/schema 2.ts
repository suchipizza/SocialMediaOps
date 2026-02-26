import { z } from "zod";

export const FitMode = z.enum(["SHRINK_TO_FIT", "TRUNCATE", "WRAP", "OVERFLOW_ERROR"]);

export const PlaceholderSchema = z.object({
  key: z.string().min(1),
  x: z.number().nonnegative(),
  y: z.number().nonnegative(),
  w: z.number().positive(),
  h: z.number().positive(),
  font_family: z.string().min(1),
  font_size: z.number().positive(),
  min_font_size: z.number().positive().optional(),
  line_height: z.number().positive().optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  fit_mode: FitMode.default("SHRINK_TO_FIT"),
  max_lines: z.number().int().positive().optional()
});

export const SlideSchema = z.object({
  index: z.number().int().positive(),
  background: z.string().optional(),
  placeholders: z.array(PlaceholderSchema).default([])
});

const BaseOutputSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  format: z.enum(["jpeg", "png"]).default("jpeg"),
  quality: z.number().int().min(1).max(100).default(90)
});

export const ManifestSchema = z.object({
  template_version: z.string().min(1),
  output: BaseOutputSchema,
  slide_count: z.number().int().positive(),
  slides: z.array(SlideSchema)
}).refine(m => m.slides.length === m.slide_count, {
  message: "slides.length must equal slide_count"
});

export const FormatCManifestSchema = z.object({
  template_format: z.literal("react-vite-v1"),
  template_version: z.string().min(1),
  output: BaseOutputSchema,
  slide_count: z.number().int().positive(),
  render: z.object({
    mode: z.literal("querystring"),
    query: z.object({
      slide: z.string().min(1),
      data: z.string().min(1)
    }),
    capture: z.enum(["slide", "inner", "auto"]).optional()
  })
});

export const AnyManifestSchema = z.union([ManifestSchema, FormatCManifestSchema]);
