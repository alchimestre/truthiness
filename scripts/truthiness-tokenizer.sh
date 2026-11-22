#!/bin/sh
# Overcounts on purpose (3 bytes per token) so the startup index stays under budget.
bytes=$(wc -c)
echo $(( (bytes + 2) / 3 ))
