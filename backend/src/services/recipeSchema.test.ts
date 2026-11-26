import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LlmRecipeSchema,
  DayMealSchema,
  RegenMealSchema,
  RecipeSlotSchema,
} from './recipeSchema.js';
// Importing aiService requires GEMINI_API_KEY to be set
// (it throws at import otherwise). The npm test script sets a dummy value;
// it is never used to call a real API.
import { getPlanDates, parseJSON, classifyFailure } from './aiService.js';

// A valid recipe matching RECIPE_SCHEMA exactly — the base for the
// failure cases below, each of which changes one field.
const validRecipe = {
  id: 'palak-paneer',
  name: 'Palak Paneer',
  cuisine: 'North Indian',
  prepTime: 10,
  cookTime: 20,
  servings: 2,
  macros: {
    calories: 450,
    carbohydrates: 52,
    protein: 28,
    fats: 14,
    fiber: 6,
    sodium: 820,
    sugar: 8,
  },
  dietaryTags: ['vegetarian'],
  equipment: ['pan'],
  ingredients: [{ name: 'paneer', quantity: 200, unit: 'g', searchTerm: 'paneer' }],
  steps: ['Heat oil.', 'Add paneer and cook.'],
  notes: 'Serve hot.',
  sourceSite: 'vegrecipesofindia.com',
};

describe('LlmRecipeSchema', () => {
  it('accepts a valid full recipe', () => {
    const result = LlmRecipeSchema.safeParse(validRecipe);
    assert.equal(result.success, true);
  });

  it('rejects a missing name', () => {
    const { name: _name, ...rest } = validRecipe;
    assert.equal(LlmRecipeSchema.safeParse(rest).success, false);
  });

  it('rejects missing macros', () => {
    const { macros: _macros, ...rest } = validRecipe;
    assert.equal(LlmRecipeSchema.safeParse(rest).success, false);
  });

  it('rejects negative calories', () => {
    const bad = { ...validRecipe, macros: { ...validRecipe.macros, calories: -10 } };
    assert.equal(LlmRecipeSchema.safeParse(bad).success, false);
  });

  it('rejects absurd calories', () => {
    const bad = { ...validRecipe, macros: { ...validRecipe.macros, calories: 999999 } };
    assert.equal(LlmRecipeSchema.safeParse(bad).success, false);
  });

  it('rejects a negative ingredient quantity', () => {
    const bad = {
      ...validRecipe,
      ingredients: [{ ...validRecipe.ingredients[0], quantity: -1 }],
    };
    assert.equal(LlmRecipeSchema.safeParse(bad).success, false);
  });

  it('rejects an empty ingredients array', () => {
    const bad = { ...validRecipe, ingredients: [] };
    assert.equal(LlmRecipeSchema.safeParse(bad).success, false);
  });

  it('rejects an empty steps array', () => {
    const bad = { ...validRecipe, steps: [] };
    assert.equal(LlmRecipeSchema.safeParse(bad).success, false);
  });

  it('rejects servings of 0', () => {
    const bad = { ...validRecipe, servings: 0 };
    assert.equal(LlmRecipeSchema.safeParse(bad).success, false);
  });

  it('rejects a negative prepTime', () => {
    const bad = { ...validRecipe, prepTime: -5 };
    assert.equal(LlmRecipeSchema.safeParse(bad).success, false);
  });

  it('rejects a quantity given as a string', () => {
    const bad = {
      ...validRecipe,
      ingredients: [{ ...validRecipe.ingredients[0], quantity: '200' }],
    };
    assert.equal(LlmRecipeSchema.safeParse(bad).success, false);
  });

  it('rejects macros given as a string', () => {
    const bad = { ...validRecipe, macros: 'lots' };
    assert.equal(LlmRecipeSchema.safeParse(bad).success, false);
  });
});

describe('DayMealSchema / RegenMealSchema / RecipeSlotSchema', () => {
  it('accepts a valid day meal', () => {
    const result = DayMealSchema.safeParse({ mealType: 'breakfast', recipe: validRecipe });
    assert.equal(result.success, true);
  });

  it('rejects a day meal with an empty mealType', () => {
    const result = DayMealSchema.safeParse({ mealType: '', recipe: validRecipe });
    assert.equal(result.success, false);
  });

  it('accepts a valid regen meal', () => {
    const result = RegenMealSchema.safeParse({
      day: 'Monday',
      date: '2026-11-16',
      mealType: 'breakfast',
      recipe: validRecipe,
    });
    assert.equal(result.success, true);
  });

  it('rejects a regen meal with a bad date format', () => {
    const result = RegenMealSchema.safeParse({
      day: 'Monday',
      date: '16-11-2026',
      mealType: 'breakfast',
      recipe: validRecipe,
    });
    assert.equal(result.success, false);
  });

  it('accepts a valid recipe slot', () => {
    const result = RecipeSlotSchema.safeParse({
      day: 'Monday',
      date: '2026-11-16',
      mealType: 'breakfast',
      recipeName: 'Palak Paneer',
      cuisineHint: 'North Indian',
      sourceSite: 'vegrecipesofindia.com',
    });
    assert.equal(result.success, true);
  });

  it('rejects a slot with a bad date format', () => {
    const result = RecipeSlotSchema.safeParse({
      day: 'Monday',
      date: '16/11/2026',
      mealType: 'breakfast',
      recipeName: 'Palak Paneer',
      cuisineHint: 'North Indian',
      sourceSite: 'vegrecipesofindia.com',
    });
    assert.equal(result.success, false);
  });

  it('rejects a slot missing recipeName', () => {
    const result = RecipeSlotSchema.safeParse({
      day: 'Monday',
      date: '2026-11-16',
      mealType: 'breakfast',
      cuisineHint: 'North Indian',
      sourceSite: 'vegrecipesofindia.com',
    });
    assert.equal(result.success, false);
  });
});

describe('classifyFailure', () => {
  it('treats a validation failure as retryable (like a 503) so the chain advances', () => {
    assert.equal(classifyFailure('Recipe validation failed: calories: too big'), '503');
  });

  it('still classifies a 429 as a 429 and anything else as fatal', () => {
    assert.equal(classifyFailure('Gemini API error 429: quota'), '429');
    assert.equal(classifyFailure('some random error'), 'fatal');
  });
});

describe('getPlanDates', () => {
  it('returns 7 days from a start date with correct day names and dates', () => {
    const { weekOf, days } = getPlanDates('2026-11-16', 7);
    assert.equal(weekOf, '2026-11-16');
    assert.equal(days.length, 7);
    assert.deepEqual(days[0], { day: 'Monday', date: '2026-11-16' });
    assert.deepEqual(days[6], { day: 'Sunday', date: '2026-11-22' });
  });

  it('clamps numDays to 1–7', () => {
    assert.equal(getPlanDates('2026-11-16', 0).days.length, 1);
    assert.equal(getPlanDates('2026-11-16', 10).days.length, 7);
    assert.equal(getPlanDates('2026-11-16').days.length, 7);
  });

  it('defaults the start date to today (UTC)', () => {
    const today = new Date().toISOString().split('T')[0] ?? '';
    assert.equal(getPlanDates().weekOf, today);
  });

  it('does not shift a date across a year boundary or near midnight', () => {
    const { days } = getPlanDates('2026-12-31', 2);
    assert.deepEqual(days.map((d) => d.date), ['2026-12-31', '2027-01-01']);
    assert.deepEqual(days.map((d) => d.day), ['Thursday', 'Friday']);
  });
});

describe('parseJSON', () => {
  it('strips markdown code fences', () => {
    assert.deepEqual(parseJSON('```json\n{"a": 1}\n```'), { a: 1 });
    assert.deepEqual(parseJSON('```\n[1, 2]\n```'), [1, 2]);
  });

  it('trims prose before and after the JSON', () => {
    assert.deepEqual(parseJSON('Here is the plan: {"a": 1} Hope this helps.'), { a: 1 });
    assert.deepEqual(parseJSON('Sure! [{"x": 1}] done.'), [{ x: 1 }]);
  });

  it('throws SyntaxError on malformed JSON', () => {
    assert.throws(() => parseJSON('not json at all'), SyntaxError);
    assert.throws(() => parseJSON('{"a": }'), SyntaxError);
  });
});
