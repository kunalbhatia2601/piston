#!/usr/bin/env bash

# Download OpenJDK 21 LTS from Oracle
curl -L "https://download.oracle.com/java/21/latest/jdk-21_linux-x64_bin.tar.gz" -o java.tar.gz

tar xzf java.tar.gz --strip-components=1
rm java.tar.gz
