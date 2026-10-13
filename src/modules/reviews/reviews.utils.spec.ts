import { describe, expect, it } from 'vitest';
import { averageRating, publicAuthorName, ratingDistribution } from './reviews.utils.js';

describe('publicAuthorName', () => {
  it("n'affiche que le prénom et l'initiale du nom", () => {
    expect(publicAuthorName('Marie Kouam Ngono')).toBe('Marie K.');
    expect(publicAuthorName('  awa   diallo ')).toBe('awa D.');
    expect(publicAuthorName('Paul')).toBe('Paul');
    expect(publicAuthorName('   ')).toBe('Voyageur');
  });
});

describe('averageRating', () => {
  it('arrondit au dixième et renvoie null sans avis', () => {
    expect(averageRating([])).toBeNull();
    expect(averageRating([5, 4, 4])).toBe(4.3);
    expect(averageRating([5])).toBe(5);
  });
});

describe('ratingDistribution', () => {
  it('compte les avis par note et ignore les notes hors 1–5', () => {
    expect(ratingDistribution([5, 5, 3, 1, 9, 0])).toEqual({ 1: 1, 2: 0, 3: 1, 4: 0, 5: 2 });
  });
});
