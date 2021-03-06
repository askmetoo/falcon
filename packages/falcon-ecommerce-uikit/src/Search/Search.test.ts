import { searchStateToURL } from './searchStateToURL';
import { searchStateFromURL } from './searchStateFromURL';
import { SortOrderDirection } from '../SortOrders/SortOrdersQuery';
import { FilterOperator } from './types';

describe('Filters', () => {
  describe('serializing and deserializing', () => {
    it('should correctly deserialize and serialize search state', () => {
      const input = {
        filters: [
          {
            field: 'price',
            operator: FilterOperator.equals,
            value: ['10']
          }
        ]
      };

      expect(searchStateFromURL(searchStateToURL(input))).toEqual(input);
    });

    it('should correctly deal with pagination', () => {
      const input = {
        pagination: {
          perPage: 10,
          page: 2
        }
      };

      expect(searchStateFromURL(searchStateToURL(input))).toEqual(input);
    });

    it('should correctly deal with sort orders', () => {
      const input = {
        sort: {
          field: 'price',
          direction: 'desc' as SortOrderDirection
        }
      };

      expect(searchStateFromURL(searchStateToURL(input))).toEqual(input);
    });

    it('should correctly deal with search query', () => {
      const input = {
        term: 'foo'
      };

      expect(searchStateFromURL(searchStateToURL(input))).toEqual(input);
    });
  });
});
