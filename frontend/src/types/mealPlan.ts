import { z } from "zod";

export const MacrosSchema = z.object({
  calories: z.number().nonnegative(),
  carbohydrates: z.number().nonnegative(),
  protein: z.number().nonnegative(),
  fats: z.number().nonnegative(),
  fiber: z.number().nonnegative(),
  sodium: z.number().nonnegative(),
  sugar: z.number().nonnegative(),
});
export type Macros = z.infer<typeof MacrosSchema>;

export const IngredientSchema = z.object({
  name: z.string().min(1),
  quantity: z.number().nonnegative(),
  unit: z.string(), 
  searchTerm: z.string().min(1), 
});
export type Ingredient = z.infer<typeof IngredientSchema>;

export const RecipeDraftSchema = z.object({
  name: z.string().min(1),
  cuisine: z.string(),
  prepTime: z.number().int().nonnegative(), // minutes
  cookTime: z.number().int().nonnegative(), // minutes
  servings: z.number().int().positive(),
  macros: MacrosSchema,
  dietaryTags: z.array(z.string()),
  equipment: z.array(z.string()),
  ingredients: z.array(IngredientSchema).min(1),
  steps: z.array(z.string().min(1)).min(1),
  notes: z.string(),
});
export type RecipeDraft = z.infer<typeof RecipeDraftSchema>;

export const RecipeSchema = RecipeDraftSchema.extend({
  id: z.string().min(1), 
  sourceSite: z.string(),
  sourceUrl: z.string().url().nullable(),
  imageUrl: z.string().url().nullable(),
  aiGenerated: z.boolean().optional(),
});
export type Recipe = z.infer<typeof RecipeSchema>;

export const MealSchema = z.object({
  mealType: z.string(), 
  recipe: RecipeSchema,
});
export type Meal = z.infer<typeof MealSchema>;

export const DayPlanSchema = z.object({
  day: z.string(), // "Monday"
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD"),
  meals: z.array(MealSchema),
});
export type DayPlan = z.infer<typeof DayPlanSchema>;

export const ShoppingItemSchema = z.object({
  searchTerm: z.string().min(1),
  displayName: z.string().min(1),
  estimatedQuantity: z.string(), 
  usedIn: z.array(z.string()),
});
export type ShoppingItem = z.infer<typeof ShoppingItemSchema>;

export const MealPlanSchema = z.object({
  weekOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD"),
  mealPlan: z.array(DayPlanSchema),
  shoppingList: z.array(ShoppingItemSchema),
});
export type MealPlan = z.infer<typeof MealPlanSchema>;