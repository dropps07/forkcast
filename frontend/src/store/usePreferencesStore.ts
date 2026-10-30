import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface Preferences {
    cuisines: string[],
    equipment: string[],
    macros: {
        maxCalories: number,
        maxFats: number,
        maxCarbs: number,
        minFiber: number,
        minProtein: number,
    }
    dietary: {
        maxSodium: number,
        maxSugar: number,
        allergens: string[],
        isVegetarian: boolean,
        isVegan: boolean,
    }
    maxPrepTime: number,
    maxCookTime: number,
    mealsPerDay: number,
    startDate: string,
    numDays: number,
    leftovers: string,
    otherPreferences :  string,
    searchMode: 'web' | 'training',
}

const defaults: Preferences = {
  cuisines: [],
  equipment: [],
  macros: {
    maxCalories: 2000,
    maxCarbs: 250,
    maxFats: 80,
    minFiber: 25,
    minProtein: 50,
  },
  dietary: {
    maxSodium: 2300,
    maxSugar: 50,
    allergens: [],
    isVegetarian: true,
    isVegan: false,
  },
  maxPrepTime: 30,
  maxCookTime: 60,
  mealsPerDay: 3,
  startDate: '',
  numDays: 7,
  leftovers: '',
  otherPreferences: '',
  searchMode: 'web',
};

export function toLocalISO(d : Date): string {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2,'0');
    return `${year}-${month}-${day}`;
}

export function todayISO(): string {
    return toLocalISO(new Date());
}

export function addDaysISO(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return toLocalISO(new Date(y, m-1, d+ days));
}

//adding action signatures
interface PreferencesState extends Preferences {
  set: (patch: Partial<Preferences>) => void;
  setMacro: (key: keyof Preferences['macros'], value: number) => void;
  setDietary: <K extends keyof Preferences['dietary']>(
    key: K,
    value: Preferences['dietary'][K]
  ) => void;
  toggleCuisine: (cuisine: string) => void;
  toggleEquipment: (item: string) => void;
  toggleAllergen: (allergen: string) => void;
  reset: () => void;
}

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      ...defaults,

      set: (patch) => set((s) => ({ ...s, ...patch })),

      setMacro: (key, value) =>
        set((s) => ({ macros: { ...s.macros, [key]: value } })),

      setDietary: (key, value) =>
        set((s) => ({ dietary: { ...s.dietary, [key]: value } })),

      toggleCuisine: (cuisine) =>
        set((s) => ({
          cuisines: s.cuisines.includes(cuisine)
            ? s.cuisines.filter((c) => c !== cuisine)
            : [...s.cuisines, cuisine],
        })),

      toggleEquipment: (item) =>
        set((s) => ({
          equipment: s.equipment.includes(item)
            ? s.equipment.filter((e) => e !== item)
            : [...s.equipment, item],
        })),

      toggleAllergen: (allergen) =>
        set((s) => ({
          dietary: {
            ...s.dietary,
            allergens: s.dietary.allergens.includes(allergen)
              ? s.dietary.allergens.filter((a) => a !== allergen)
              : [...s.dietary.allergens, allergen],
          },
        })),

      reset: () => set(defaults),
    }),
    {
      name: 'forkcast-preferences',
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<PreferencesState>;
        return {
          ...current,
          ...p,
          macros: { ...defaults.macros, ...p.macros },
          dietary: { ...defaults.dietary, ...p.dietary },
        };
      },
    }
  )
);

export const CUISINES = [
  'American', 'Caribbean', 'Chinese', 'Filipino', 'French', 'Greek', 'Indian',
  'Italian', 'Japanese', 'Korean', 'Mediterranean',
  'Mexican', 'Middle Eastern', 'Spanish', 'Thai', 'Vietnamese',
];

export const EQUIPMENT = [
  'Oven', 'Stovetop', 'Air Fryer', 'Slow Cooker',
  'Instant Pot', 'Microwave', 'Pan', 'Blender',
];

export const ALLERGENS = [
  'Dairy', 'Eggs', 'Gluten', 'Peanuts',
  'Tree Nuts', 'Shellfish', 'Soy', 'Sesame',
];