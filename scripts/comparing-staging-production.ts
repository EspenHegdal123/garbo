import 'dotenv/config';
import fetch from 'node-fetch';
import { writeFile } from 'fs/promises';
import { resolve } from 'path';
import * as schemas from "../src/api/schemas/response";
import * as z from "zod";
import Papa from 'papaparse'; // Library for generating CSV

type CompanyList = z.infer<typeof schemas.CompanyList>;

// Define URLs
const STAGING_API_URL = "http://localhost:3000/api";
const PRODUCTION_API_URL = "https://api.klimatkollen.se/api";

// Fetch companies from a given API URL and validate with Zod schema
async function fetchCompanies(baseURL: string): Promise<CompanyList> {
  const response = await fetch(`${baseURL}/companies`, { method: 'GET' });
  if (!response.ok) {
    throw new Error(`Failed to fetch data from ${baseURL}: ${response.statusText}`);
  }
  const data = await response.json();
  const validatedData = schemas.CompanyList.parse(data);
  console.log(`Fetched data from ${baseURL}:`, validatedData.length, 'companies');
  return validatedData;
}

function formatYear(date: string): string {
  return new Date(date).getFullYear().toString(); // Extract and return just the year
}

// Helper function to format numbers with spaces every three digits and add currency
function formatCurrency(amount: number, currency: string): string {
  return `${new Intl.NumberFormat('en-US', { useGrouping: true }).format(amount).replace(/,/g, ' ')} ${currency}`;
}

// Compare data between staging and production
function compareData(stagingData: CompanyList, productionData: CompanyList): any[] {
  const comparisonResults: any[] = [];

  for (const prodCompany of productionData) {
    const stageCompany = stagingData.find(
      (comp) => comp.wikidataId === prodCompany.wikidataId
    );

    if (!stageCompany) {
      // If the company does not exist in staging
      comparisonResults.push({
        name: prodCompany.name,
        matchedFields: [],
        mismatchedFields: ['Company does not exist in staging'],
        accuracy: 0,
        note: "Exists in production but not in staging",
      });
      continue;
    }

    const comparisonResult = {
      name: prodCompany.name,
      matchedFields: [],
      mismatchedFields: [],
      accuracy: 0, 
    };

    let matchedFieldCount = 0; 
    let totalFieldCount = 0;  

    // Compare reporting periods based on endDate (only the year)
    for (const prodReportingPeriod of prodCompany.reportingPeriods) {
      const stageReportingPeriod = stageCompany.reportingPeriods.find(
        (rp) => formatYear(rp.endDate) === formatYear(prodReportingPeriod.endDate)
      );

      const year = formatYear(prodReportingPeriod.endDate);

      if (!stageReportingPeriod) {
        // If the reporting period does not exist in staging
        comparisonResult.mismatchedFields.push(`Reporting period: ${year}`);
        continue;
      }
      
      // Compare emissions fields for Scope 1, Scope 2, and Scope 3
      matchedFieldCount += compareEmissions('scope1', prodReportingPeriod.emissions?.scope1, stageReportingPeriod.emissions?.scope1, comparisonResult, year);
      totalFieldCount += 1;
      matchedFieldCount += compareEmissions('scope2', prodReportingPeriod.emissions?.scope2, stageReportingPeriod.emissions?.scope2, comparisonResult, year);
      totalFieldCount += 3;
      matchedFieldCount += compareScope3(prodReportingPeriod.emissions?.scope3, stageReportingPeriod.emissions?.scope3, comparisonResult, year);
      totalFieldCount += (prodReportingPeriod.emissions?.scope3?.categories?.length || 0 )  + 1; // Add the number of categories

      // Compare calculatedTotalEmissions and statedTotalEmissions
      matchedFieldCount += compareTotalEmissions(prodReportingPeriod.emissions, stageReportingPeriod.emissions, comparisonResult, year);
      totalFieldCount += 2;
      // Compare economy fields: employees and economy
      matchedFieldCount += compareEconomy(prodReportingPeriod.economy, stageReportingPeriod.economy, comparisonResult, year);
      totalFieldCount += 2;
    }

    // Calculate the accuracy
    if (totalFieldCount > 0) {
      comparisonResult.accuracy = parseFloat(((matchedFieldCount / totalFieldCount) * 100).toFixed(2));
    } else {
      comparisonResult.accuracy = 0;
    }

    // Add a comment based on accuracy
    if (comparisonResult.mismatchedFields.length === 0) {
      comparisonResult.note = "All data matches between production and staging";
    } else {
      comparisonResult.note = "Partial mismatch or missing data between production and staging";
    }

    comparisonResults.push(comparisonResult);
  }

  return comparisonResults;
}

// Compare economy data: employees and economy
function compareEconomy(
  prodEconomy: any,
  stageEconomy: any,
  comparisonResult: any,
  year: string // 
): number {
  let matchedFieldCount = 0;

  
  const prodEmployees = prodEconomy?.employees?.value;
  const stageEmployees = stageEconomy?.employees?.value;

  if (prodEmployees !== undefined && stageEmployees !== undefined) {
    if (prodEmployees === stageEmployees) {
      comparisonResult.matchedFields.push(`employees: ${prodEmployees}`); // Show actual value
      matchedFieldCount++;
    } else {
      comparisonResult.mismatchedFields.push(`employees: Production(${prodEmployees}) vs Staging(${stageEmployees})`); // Show both values. 
    }
  }

  // Compare economy 
  const prodEconomyValue = prodEconomy?.turnover?.value;
  const prodEconomyCurrency = prodEconomy?.turnover?.currency;
  const stageEconomyValue = stageEconomy?.turnover?.value;
  const stageEconomyCurrency = stageEconomy?.turnover?.currency;

  if (prodEconomyValue !== undefined && stageEconomyValue !== undefined) {
    const formattedProdEconomy = formatCurrency(prodEconomyValue, prodEconomyCurrency); // Format currency
    const formattedStageEconomy = formatCurrency(stageEconomyValue, stageEconomyCurrency); // Format currency

    if (prodEconomyValue === stageEconomyValue && prodEconomyCurrency === stageEconomyCurrency) {
      comparisonResult.matchedFields.push(`economy: ${formattedProdEconomy}`); // Show formatted value with currency
      matchedFieldCount++;
    } else {
      comparisonResult.mismatchedFields.push(
        `economy: Production(${formattedProdEconomy}) vs Staging(${formattedStageEconomy})`
      ); // Show both formatted values with currency
    }
  }

  return matchedFieldCount;
}

// Compare emissions for Scope 1 and Scope 2 (using only the year)
function compareEmissions(
  scopeName: string,
  prodScope: any,
  stageScope: any,
  comparisonResult: any,
  year: string // 
): number {
  const fields = ['total', 'mb', 'lb', 'unknown']; // Standard emissions fields
  let matchedFieldCount = 0;

  if (!prodScope && !stageScope) return matchedFieldCount; 

  for (const field of fields) {
    const prodValue = prodScope?.[field];
    const stageValue = stageScope?.[field];

    if (prodValue !== undefined && stageValue !== undefined) {
      if (prodValue === stageValue) {
        comparisonResult.matchedFields.push(`${scopeName}.${field}: ${year}`); 
        matchedFieldCount++;
      } else {
        comparisonResult.mismatchedFields.push(`${scopeName}.${field}: ${year}`); 
      }
    }
  }

  return matchedFieldCount;
}

// Compare Scope 3-specific data (categories and statedTotalEmissions)
function compareScope3(
  prodScope3: any,
  stageScope3: any,
  comparisonResult: any,
  year: string 
): number {
  let matchedFieldCount = 0;

  if (!prodScope3 && !stageScope3) return matchedFieldCount; 

  // Compare statedTotalEmissions
  if (prodScope3?.statedTotalEmissions?.total === stageScope3?.statedTotalEmissions?.total) {
    if (prodScope3?.statedTotalEmissions?.total != null) {
      comparisonResult.matchedFields.push(`scope3.statedTotalEmissions.total: ${year}`); 
      matchedFieldCount++;
    }
  } else {
    comparisonResult.mismatchedFields.push(`scope3.statedTotalEmissions.total: ${year}`); 
  }

  // Compare Scope 3 categories
  if (prodScope3?.categories && stageScope3?.categories) {
    for (const prodCategory of prodScope3.categories) {
      const stageCategory = stageScope3.categories.find(cat => cat.category === prodCategory.category);

      if (!stageCategory) {
        comparisonResult.mismatchedFields.push(`scope3.category=${prodCategory.category}: ${year}`); 
        continue;
      }

      if (prodCategory.total === stageCategory.total) {
        comparisonResult.matchedFields.push(`scope3.category=${prodCategory.category}: ${year}`); 
        matchedFieldCount++;
      } else {
        comparisonResult.mismatchedFields.push(`scope3.category=${prodCategory.category}: ${year}`); 
      }
    }
  }

  return matchedFieldCount;
}

// Compare calculatedTotalEmissions and statedTotalEmissions 
function compareTotalEmissions(
  prodEmissions: any,
  stageEmissions: any,
  comparisonResult: any,
  year: string 
): number {
  let matchedFieldCount = 0;

  const prodCalculated = prodEmissions?.calculatedTotalEmissions;
  const stageCalculated = stageEmissions?.calculatedTotalEmissions;

  if (prodCalculated === stageCalculated) {
    if (prodCalculated != null) {
      comparisonResult.matchedFields.push(`calculatedTotalEmissions: ${year}`); 
      matchedFieldCount++;
    }
  } else {
    comparisonResult.mismatchedFields.push(`calculatedTotalEmissions: ${year}`); 
  }

  const prodStated = prodEmissions?.statedTotalEmissions?.total;
  const stageStated = stageEmissions?.statedTotalEmissions?.total;

  if (prodStated === stageStated) {
    if (prodStated != null) {
      comparisonResult.matchedFields.push(`statedTotalEmissions.total: ${year}`); 
      matchedFieldCount++;
    }
  } else {
    comparisonResult.mismatchedFields.push(`statedTotalEmissions.total: ${year}`); 
  }

  return matchedFieldCount;
}

// Generate CSV file from comparison results
async function generateCSV(results: any[]) {
  
  const csvData = results.map((result) => {
    // Map mismatched fields to quickly find differences by field name
    const mismatchedMap = result.mismatchedFields.reduce((acc: any, field: any) => {
      acc[field.field] = {
        production: field.production || "N/A",
        staging: field.staging || "N/A",
      };
      return acc;
    }, {});

    return {
      name: result.name,
      inStaging: result.inStaging ? "Yes" : "No", // Indicate if the company exists in staging data
      scope1: resolveMatchOrDifference("scope1", mismatchedMap, result.matchedFields), // Scope 1 Emissions
      scope2: resolveMatchOrDifference("scope2", mismatchedMap, result.matchedFields), // Scope 2 Emissions
      scope3: resolveMatchOrDifference("scope3", mismatchedMap, result.matchedFields), // Scope 3 Emissions
      employees: resolveMatchOrDifference("employees", mismatchedMap, result.matchedFields), // Employees comparison
      economy: resolveMatchOrDifference("economy", mismatchedMap, result.matchedFields), // Turnover comparison
      accuracy: result.accuracy, // Include the calculated accuracy directly
    };
  });

  // Convert to CSV using PapaParse
  const csvContent = Papa.unparse(csvData, {
    header: true,
  });

  // Write CSV to a file
  const outputPath = resolve("output", "accuracy-results.csv");
  await writeFile(outputPath, csvContent, "utf8");
  console.log(`✅ CSV results written to ${outputPath}`);
}

// Helper function to determine whether to show "Yes" or the Production and Staging values
function resolveMatchOrDifference(fieldName: string, mismatchedMap: any, matchedFields: string[]): string {
  // Case 1: If the field is mismatched
  if (mismatchedMap[fieldName]) {
    const prodValue = mismatchedMap[fieldName].production;
    const stageValue = mismatchedMap[fieldName].staging;
    return `Production: ${prodValue}, Staging: ${stageValue}`;
  }

  // Case 2: If the field is matched
  const matchedField = matchedFields.find((field) => field.startsWith(fieldName));
  if (matchedField) {
    return "Yes"; // Indicate that the field matches exactly
  }

  // Case 3: If neither matched nor mismatched, return "N/A"
  return "N/A";
}

// Output results to a JSON file
async function outputResults(results: any[]) {
  const outputPath = resolve("output", "accuracy-results.json");
  await writeFile(outputPath, JSON.stringify(results, null, 2), "utf8");
  console.log(`✅ Accuracy results written to ${outputPath}`);
}

// Main function for fetching, comparison, and outputting results
async function main() {
  try {
    const stagingData = await fetchCompanies(STAGING_API_URL);
    const productionData = await fetchCompanies(PRODUCTION_API_URL);
    const comparisonResults = compareData(stagingData, productionData);

    // Write JSON output
    await outputResults(comparisonResults);

    // Generate CSV
    await generateCSV(comparisonResults); // Add this line to ensure the CSV is created
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}
main();