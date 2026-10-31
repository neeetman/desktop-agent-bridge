"""Claude monitor entry point with verified cold-start support."""
import argparse
from pathlib import Path
from native_monitor import monitor
if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--launch', type=Path)
    monitor('claude', parser.parse_args().launch)
