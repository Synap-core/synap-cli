import chalk from "chalk";
import { useState } from "react";

export default function Cell() {
  useState(0);
  return chalk.red("hi");
}
