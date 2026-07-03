/**
 * Boiler plate for scripts.
 * Scripts are an alternative entry to the system that enables testing key integration points
 * The standard is to use Commander.js, following the key conventions
 * ```
 */
import { Command } from "commander";

const program = new Command();

/**
 * bun src/bin/script.ts --flag
 */
program
  .description("This is the description program")
  .option("-f, --flag", "This is the description for the flag option")
  .action(() => {
    // This is the action that will be executed when the command is run
    console.log(
      "This is the action that will be executed when the command is run",
    );
  });

program.parse(process.argv);
