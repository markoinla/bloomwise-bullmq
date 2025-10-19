#!/bin/bash

# PaintMapper Git Commit Script
# Handles git add, commit with prompted message, and push with remote tracking

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}📝 [COMMIT]${NC} $1"
}

print_success() {
    echo -e "${GREEN}✅ [SUCCESS]${NC} $1"
}

print_error() {
    echo -e "${RED}❌ [ERROR]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠️  [WARNING]${NC} $1"
}

# Check if we're in a git repository
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    print_error "Not in a git repository!"
    exit 1
fi

print_status "Starting commit process..."

# Get current branch name
current_branch=$(git branch --show-current)
print_status "Current branch: $current_branch"

# Check if there are any changes to commit
if git diff-index --quiet HEAD -- && git diff-index --cached --quiet HEAD --; then
    print_warning "No changes to commit!"
    print_status "Working directory is clean."
    
    # Ask if user wants to push anyway
    echo ""
    print_status "Would you like to push the current branch? (y/N)"
    read -r -p "Choice: " push_choice
    
    case "$push_choice" in
        [Yy]*)
            print_status "Skipping commit, proceeding to push..."
            ;;
        *)
            print_status "Nothing to do. Exiting."
            exit 0
            ;;
    esac
else
    # Show current status
    print_status "Current git status:"
    echo ""
    git status --short
    echo ""
    
    # Check if there are any staged changes
    has_staged_changes=false
    if ! git diff-index --cached --quiet HEAD --; then
        has_staged_changes=true
    fi
    
    # Check if there are any unstaged changes
    has_unstaged_changes=false
    if ! git diff-index --quiet HEAD --; then
        has_unstaged_changes=true
    fi
    
    if [ "$has_unstaged_changes" = true ]; then
        print_status "Adding all changes (git add -A)..."
        git add -A
        print_success "All changes staged"
    fi
    
    # Prompt for commit message
    echo ""
    print_status "Enter your commit message:"
    read -r -p "Commit message: " commit_message
    
    # Check if commit message is empty
    if [ -z "$commit_message" ]; then
        print_error "Commit message cannot be empty!"
        print_status "Please enter a commit message:"
        read -r -p "Commit message: " commit_message
        
        if [ -z "$commit_message" ]; then
            print_error "Commit aborted due to empty commit message."
            exit 1
        fi
    fi
    
    # Commit the changes
    print_status "Committing changes..."
    if git commit -m "$commit_message"; then
        print_success "Changes committed successfully!"
    else
        print_error "Failed to commit changes!"
        exit 1
    fi
fi

# Check if branch has an upstream
echo ""
print_status "Checking remote tracking for branch '$current_branch'..."

upstream=$(git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null || echo "")

if [ -z "$upstream" ]; then
    print_warning "Branch '$current_branch' is not tracking a remote branch."
    print_status "Would you like to push and set up remote tracking? (Y/n)"
    echo "  Y - Yes, push to origin/$current_branch and set up tracking (default)"
    echo "  n - No, skip pushing"
    read -r -p "Choice: " remote_choice
    
    case "$remote_choice" in
        [Nn]*)
            print_status "Skipping push. Commit completed."
            exit 0
            ;;
        *)
            print_status "Pushing to origin/$current_branch and setting up remote tracking..."
            if git push -u origin "$current_branch"; then
                print_success "Successfully pushed and set up remote tracking for '$current_branch'"
            else
                print_error "Failed to push to origin/$current_branch"
                print_status "You may need to create the remote branch manually or check your permissions."
                exit 1
            fi
            ;;
    esac
else
    print_success "Branch '$current_branch' is tracking '$upstream'"
    print_status "Pushing to remote..."
    
    if git push; then
        print_success "Successfully pushed to $upstream"
    else
        print_error "Failed to push to $upstream"
        print_status "Check your network connection and remote repository permissions."
        exit 1
    fi
fi

echo ""
print_success "Commit and push completed successfully!"
print_status "Summary:"
echo "  Branch: $current_branch"
if [ -n "$commit_message" ]; then
    echo "  Commit: $commit_message"
fi
echo "  Remote: $(git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null || echo 'origin/'$current_branch)" 