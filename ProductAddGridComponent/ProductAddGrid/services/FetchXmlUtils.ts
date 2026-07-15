/**
 * FetchXmlUtils - Utilities for building and manipulating FetchXML queries
 * Centralizes all FetchXML operations used across the PCF control
 */

import { ProductFilterCondition, SearchMatchType } from '../types';

/**
 * FetchXML namespace for creating properly namespaced elements
 */
const FETCH_XML_NAMESPACE = 'http://schemas.microsoft.com/FetchXML/2006';

/**
 * Singleton instances for XML parsing/serialization
 * Reusing these avoids creating new instances on every call
 */
const domParser = new DOMParser();
const xmlSerializer = new XMLSerializer();

/**
 * Escape special XML characters in a string value
 * Essential for preventing XML injection and ensuring valid FetchXML
 */
function escapeXmlValue(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Create an XML element with the FetchXML namespace
 */
function createFetchElement(doc: Document, tagName: string): Element {
  return doc.createElementNS(FETCH_XML_NAMESPACE, tagName);
}

/**
 * Internal helper: parse FetchXML, find <entity>, apply modifier, serialize.
 * Returns original fetchXml on any error or missing <entity>.
 */
function modifyFetchXml(
  fetchXml: string,
  modifier: (xmlDoc: Document, entityElement: Element) => void,
  _errorContext: string
): string {
  try {
    const xmlDoc = domParser.parseFromString(fetchXml, 'text/xml');
    const entityElement = xmlDoc.querySelector('entity');
    if (!entityElement) return fetchXml;
    modifier(xmlDoc, entityElement);
    return xmlSerializer.serializeToString(xmlDoc);
  } catch (_error) {
    return fetchXml;
  }
}

/**
 * Add search filters to existing FetchXML
 * Creates an OR filter searching across the specified fields
 */
export function addSearchFilterToFetchXML(fetchXml: string, searchQuery: string, searchFields: string[], matchType: SearchMatchType = 'startsWith'): string {
  const leadingWildcard = matchType === 'contains' ? '%' : '';
  return modifyFetchXml(fetchXml, (xmlDoc, entityElement) => {
    const filterElement = createFetchElement(xmlDoc, 'filter');
    filterElement.setAttribute('type', 'or');

    for (const fieldName of searchFields) {
      const condition = createFetchElement(xmlDoc, 'condition');
      condition.setAttribute('attribute', fieldName);
      condition.setAttribute('operator', 'like');
      condition.setAttribute('value', `${leadingWildcard}${searchQuery}%`);
      filterElement.appendChild(condition);
    }

    entityElement.appendChild(filterElement);
  }, 'modifying FetchXML for search');
}

/**
 * Set page size in FetchXML by adding count attribute to entity
 */
export function setPageSizeInFetchXML(fetchXml: string, pageSize: number): string {
  return modifyFetchXml(fetchXml, (_xmlDoc, entityElement) => {
    entityElement.setAttribute('count', pageSize.toString());
  }, 'setting page size in FetchXML');
}

/**
 * Recursively append a filter clause (leaf condition or nested boolean group) as a DOM node.
 * A clause with `conditions` renders as a nested <filter type=...>; otherwise a leaf <condition>.
 */
function appendFilterClause(xmlDoc: Document, parentEl: Element, cond: ProductFilterCondition): void {
  // Nested boolean group
  if (cond.conditions && cond.conditions.length > 0) {
    const groupFilter = createFetchElement(xmlDoc, 'filter');
    groupFilter.setAttribute('type', cond.type ?? 'and');
    for (const child of cond.conditions) {
      appendFilterClause(xmlDoc, groupFilter, child);
    }
    parentEl.appendChild(groupFilter);
    return;
  }

  const conditionElement = createFetchElement(xmlDoc, 'condition');
  conditionElement.setAttribute('attribute', String(cond.attribute));
  conditionElement.setAttribute('operator', String(cond.operator));

  if (cond.operator === 'in' || cond.operator === 'not-in') {
    for (const v of cond.values ?? []) {
      const valueElement = createFetchElement(xmlDoc, 'value');
      valueElement.textContent = String(v);
      conditionElement.appendChild(valueElement);
    }
  } else if (cond.operator !== 'not-null' && cond.operator !== 'null') {
    conditionElement.setAttribute('value', String(cond.value));
  }

  parentEl.appendChild(conditionElement);
}

/**
 * Recursively render a filter clause (leaf condition or nested boolean group) as a FetchXML string.
 * A clause with `conditions` renders as a nested <filter type=...>; otherwise a leaf <condition>.
 */
function renderFilterClauseXml(cond: ProductFilterCondition): string {
  // Nested boolean group
  if (cond.conditions && cond.conditions.length > 0) {
    const type = cond.type ?? 'and';
    return `<filter type="${type}">${cond.conditions.map(renderFilterClauseXml).join('')}</filter>`;
  }

  const attribute = escapeXmlValue(String(cond.attribute));
  if (cond.operator === 'in' || cond.operator === 'not-in') {
    const valueElements = (cond.values ?? [])
      .map(v => `<value>${escapeXmlValue(String(v))}</value>`)
      .join('');
    return `<condition attribute="${attribute}" operator="${cond.operator}">${valueElements}</condition>`;
  }
  if (cond.operator === 'not-null' || cond.operator === 'null') {
    return `<condition attribute="${attribute}" operator="${cond.operator}" />`;
  }
  return `<condition attribute="${attribute}" operator="${String(cond.operator)}" value="${escapeXmlValue(String(cond.value))}" />`;
}

/**
 * Add product filter conditions to existing FetchXML
 * Creates an AND filter for product filtering (e.g., in-stock, software, etc.)
 */
export function addProductFilterToFetchXML(
  fetchXml: string,
  filterConditions: ProductFilterCondition[]
): string {
  if (filterConditions.length === 0) {
    return fetchXml;
  }

  return modifyFetchXml(fetchXml, (xmlDoc, entityElement) => {
    const filterElement = createFetchElement(xmlDoc, 'filter');
    filterElement.setAttribute('type', 'and');

    for (const condition of filterConditions) {
      appendFilterClause(xmlDoc, filterElement, condition);
    }

    entityElement.appendChild(filterElement);
  }, 'modifying FetchXML for product filter');
}

/**
 * Create a FetchXML query for products with specific columns
 * Builds a complete product query with search, filtering, sorting, and pagination
 * 
 * @param searchQuery - Search term (searches specified fields)
 * @param pageSize - Number of records per page
 * @param pageNumber - Current page number (1-based)
 * @param columns - Array of column logical names to include
 * @param filterConditions - Optional product filter conditions
 * @param searchFields - Array of field names to search (defaults to ['name', 'productnumber'])
 * @param sortConfig - Array of sort configurations (defaults to name ascending)
 * @param entityName - Entity name to query (defaults to 'product')
 * @returns Complete FetchXML query string
 */
export function createProductFetchXMLWithColumns(
  searchQuery: string, 
  pageSize: number, 
  pageNumber: number, 
  columns: string[],
  filterConditions: ProductFilterCondition[],
  searchFields: string[],
  sortConfig: { attribute: string; descending: boolean }[] = [{ attribute: 'name', descending: false }],
  entityName = 'product',
  matchType: SearchMatchType = 'startsWith'
): string {
  // Escape search query for XML safety
  const escapedSearchQuery = escapeXmlValue(searchQuery.trim());
  const leadingWildcard = matchType === 'contains' ? '%' : '';

  // Build search filter using configured search fields
  const searchFilter = escapedSearchQuery ?
    `<filter type="or">
      ${searchFields.map(field =>
        `<condition attribute="${escapeXmlValue(field)}" operator="like" value="${leadingWildcard}${escapedSearchQuery}%" />`
      ).join('\n      ')}
    </filter>` : '';

  // Build base filter for required conditions (always applied)
  // Exclude products with null or empty names
  // Only include active products (statecode = 0)
  const baseFilter = `<filter type="and">
      <condition attribute="statecode" operator="eq" value="0" />
      <condition attribute="name" operator="not-null" />
      <condition attribute="name" operator="ne" value="" />
    </filter>`;

  // Build product filter conditions (AND logic; clauses may be nested OR/AND groups)
  const productFilter = filterConditions.length > 0
    ? `<filter type="and">
      ${filterConditions.map(renderFilterClauseXml).join('\n      ')}
    </filter>`
    : '';

  const attributeElements = columns.map(col => `<attribute name="${escapeXmlValue(col)}" />`).join('\n      ');

  // Build sort order elements from config
  const orderElements = sortConfig
    .map(sort => `<order attribute="${escapeXmlValue(sort.attribute)}" descending="${sort.descending}" />`)
    .join('\n      ');

  // Fetch pageSize+1 to detect if there are more records beyond current page
  const fetchCount = pageSize + 1;

  return `<fetch version="1.0" output-format="xml-platform" mapping="logical" distinct="false" count="${fetchCount}" page="${pageNumber}">
    <entity name="${escapeXmlValue(entityName)}">
      ${attributeElements}
      ${baseFilter}
      ${searchFilter}
      ${productFilter}
      ${orderElements}
    </entity>
  </fetch>`;
}
