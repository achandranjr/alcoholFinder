import { config } from '../config.js';
import { defineApiSource } from './runtime/apiSource.js';

/**
 * Open Brewery DB — free, no-auth worldwide brewery/cidery/brewpub dataset.
 * Producer-level: each record is a brewery used as a seed candidate. Because it
 * needs no key it ALWAYS runs, so it's the baseline source that keeps discovery
 * returning results even when the keyed sources (COLA Cloud, agentic web) are
 * unavailable. Built on the same declarative API runtime as user-added sources.
 * Docs: https://www.openbrewerydb.org/documentation
 */
export const openBreweryDb = defineApiSource({
  id: 'open_brewery_db',
  label: 'Open Brewery DB',
  addedFrom: 'https://api.openbrewerydb.org',
  spec: {
    baseUrl: config.OPENBREWERYDB_BASE_URL,
    docsUrl: 'https://www.openbrewerydb.org/documentation',
    listPath: '/breweries',
    queryParams: { sort: 'name:asc' },
    pageParam: 'page',
    itemsPath: '', // the /breweries response is a bare JSON array
    fieldMap: {
      brand: 'name',
      producer: 'name',
      beverageClass: 'brewery_type',
      origin: 'country',
      sourceRef: 'id',
      sourceUrl: 'website_url',
    },
    auth: { type: 'none' },
    credentials: [],
  },
});
